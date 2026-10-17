import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { join } from "path";
import {
  resolvePluginSpecifier,
  type PluginTree,
  type PluginNode,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  createFacet,
  getFacet,
  type DocFact,
  type DocFactGroup,
  type ExtractContext,
} from "@plugins/plugin-meta/plugins/facets/core";
import {
  type SlotDef,
  slotsFacetDef,
} from "@plugins/plugin-meta/plugins/facets/plugins/slots/core";
import {
  readIfExists,
  stripTypes,
  maskSource,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import {
  type Contribution,
  type ContributionsFacetData,
  type DocMetaContribution,
  type SourceRef,
  contributionsFacetDef,
} from "../core";
import {
  parseImports,
  extractContributionsBlock,
  findCalls,
  parsePropsBlock,
  parsePaneDeclarations,
  parseRouteDeclarations,
  sourceRef,
} from "./internal/static-parse";

export default createFacet<ContributionsFacetData>({
  def: contributionsFacetDef,

  extract(ctx: ExtractContext): ContributionsFacetData {
    // Static contributions from web barrel source
    const staticContributions: Contribution[] = [];
    // Join inputs for `relate()`. Both are LOCAL facts — what this plugin's own
    // files declare — which is the whole reason `extract()` can stay per-plugin
    // while pane identity has stopped being local: a route-form pane names a
    // `defineRoute()` that usually lives in another plugin's `core/`, and there
    // is no root or tree in `ExtractContext` to chase it with.
    const panes = parsePaneDeclarations(ctx.dir);
    const routes = parseRouteDeclarations(ctx.dir);
    const paneRefs: Record<string, SourceRef> = {};
    const webIndex = readIfExists(join(ctx.dir, "web", "index.ts"));
    if (webIndex) {
      // Mask the source FULLY (comments/regex AND string interiors blanked) and
      // locate the block + each call over the mask, then read the real slot
      // name / prop values back from the ORIGINAL by offset. A contribution call
      // written inside a string or template literal (a fixture, a docs snippet)
      // then vanishes from the mask, while a real call's blanked string args are
      // recovered from the original — closing the string-embedding false-positive
      // class. `maskSource` preserves offsets 1:1, so masked and stripped align.
      const stripped = stripTypes(webIndex);
      const masked = maskSource(stripped);
      const block = extractContributionsBlock(masked);
      if (block !== null) {
        // parseImports masks internally via findImports, so it takes the raw
        // (type-stripped) source directly, not the masked copy.
        const importMap = parseImports(stripped);
        const maskedBlock = masked.slice(block.start, block.end);
        const origBlock = stripped.slice(block.start, block.end);
        for (const call of findCalls(maskedBlock, origBlock)) {
          const [head, ...rest] = call.callee.split(".");
          const tail = rest.join(".");
          const imp = importMap.get(head!);
          const displayHead =
            imp && imp.original !== "default" ? imp.original : head!;
          const slot = `${displayHead}.${tail}`;
          const props = parsePropsBlock(call.argsBody);
          const contribution: Contribution = { slot, props };
          if ("companion" in props) {
            // The closure engine bundles a companion by this flag alone, so a
            // value it cannot read is not "probably true" — it is a companion
            // that would silently ship as an option, the incident the flag
            // exists to prevent.
            if (props["companion"] !== "true") {
              throw new Error(
                `${join(ctx.dir, "web", "index.ts")}: \`${call.callee}({ companion: ${props["companion"]} })\` — ` +
                  "a contribution's `companion` must be the literal `true` (or absent): " +
                  "the closure engine reads it statically to ship the contribution with its slot's owner.",
              );
            }
            contribution.companion = true;
          }
          if (slot === "Pane.Register" && props["pane"]) {
            // Record only where the registered pane variable COMES FROM; the id
            // itself is resolved in `relate()`. A barrel can register a pane
            // defined in another plugin's `web/` — `settings/accounts` has always
            // registered `auth`'s `accountsPane`, and got no id for it.
            const local = props["pane"].trim();
            const ref = sourceRef(local, importMap);
            if (ref?.module) paneRefs[local] = ref;
          }
          staticContributions.push(contribution);
        }
      }
    }

    // Runtime contributions from barrel imports (existing logic)
    const runtimeContributions: DocMetaContribution[] = [];
    // Barrels and the naming of the pass over them arrive together, and that
    // pairing is load-bearing here more than anywhere else. A plugin's
    // `contributions` array is not always a literal in its barrel: `reorder`'s
    // starts empty and is filled by a `subscribeSlotsDeclared` callback — one
    // config directive per reorderable slot — so it holds 0 entries until a
    // declaration pass has run, and ~240 after. Reading the barrels without one
    // answers with a smaller set indistinguishable from a correct one: that is
    // how a `docs/plugins-details.md` missing reorder's whole `Contributes:`
    // block got committed, and how it made `main` un-pushable four commits
    // later. A runtime assert (`slotDeclarationPasses() === 0`) used to stand
    // here and refuse the early read; `ExtractContext.imported` now makes that
    // state unspellable, so the assert has nothing left to catch.
    //
    // The `skipBarrelImport` path passes no modules, so this block is skipped,
    // and facets never run in the browser.
    const imported = ctx.imported;
    if (imported && imported.modules.length > 0) {
      const { naming } = imported;
      for (const { mod } of imported.modules) {
        let def: Record<string, unknown> | undefined;
        try {
          def = mod.default as Record<string, unknown> | undefined;
        } catch (err) {
          if (!(err instanceof TypeError)) throw err;
          continue;
        }
        if (!def) continue;

        // `_pluginId` is stamped onto each contribution only at runtime by
        // PluginProvider (`_pluginId = p.id`); the raw barrel export imported
        // here carries neither it nor a `def.id` (the loader injects the plugin
        // id, plugins never author it). The authoritative owner is the node
        // whose barrel we're importing, so `pluginId` is filled in `relate()`
        // from `node.id` — matching the runtime `entryKey` (`${p.id}:${id}`).
        const rawContributions = def.contributions as
          | Array<
              Record<string, unknown> & {
                _slot?: SlotHandle;
                _kind?: symbol;
                id?: string;
                _doc?: { label?: string; detail?: string };
              }
            >
          | undefined;
        if (!rawContributions) continue;

        for (const c of rawContributions) {
          // WHICH RUNTIME a contribution belongs to is decided here, by which
          // marker it carries — `_slot` (a web contribution, targeting a slot)
          // or a `_kind` symbol (a server registration). It used to be decided
          // by whether the slot could be NAMED, which quietly conflated "this is
          // not a web contribution" with "nobody has named this slot yet".
          if (c._slot) {
            const lookup = naming.idOf(c._slot);
            // Out of scope is a real answer, not a failure to report: this
            // extraction's pass covers the whole checkout, so a slot it did not
            // name is one no plugin declares anywhere — an orphan, which the
            // build-time orphan guard owns and reports on its own terms. Skip it
            // here rather than inventing a name for it.
            if (lookup.kind !== "named") continue;
            const comp = c.component;
            const componentName =
              typeof comp === "function" && comp.name
                ? (comp.name as string)
                : undefined;
            runtimeContributions.push({
              kind: "slot",
              slotId: lookup.id,
              // slotDisplayName + pluginId filled in by relate()
              componentName,
              doc: c._doc ?? {},
              id: typeof c.id === "string" ? c.id : undefined,
              ...(c.companion === true ? { companion: true as const } : {}),
            });
          } else if (typeof c._kind === "symbol" && c._kind.description) {
            // server registration (defineServerContribution): the `_kind` symbol's
            // description is the registry token (e.g. "page.block-data").
            runtimeContributions.push({
              kind: "server",
              slotId: c._kind.description,
              // pluginId filled in by relate(); no component, no SlotDef display name.
              doc: c._doc ?? {},
              id: typeof c.id === "string" ? c.id : undefined,
            });
          }
          // else: no recognizable marker → skip (unchanged for malformed entries)
        }
      }
    }

    return {
      static: staticContributions,
      runtime: runtimeContributions,
      panes,
      routes,
      paneRefs,
    };
  },

  relate(rawCtx) {
    const { tree } = rawCtx as { tree: PluginTree };

    // Build slotId -> displayName from the slots facet
    const slotDisplayNames = new Map<string, string>();
    for (const node of tree.byDir.values()) {
      const nodeSlots = getFacet(node, slotsFacetDef) ?? [];
      for (const s of nodeSlots) {
        if (!slotDisplayNames.has(s.slotId)) {
          slotDisplayNames.set(
            s.slotId,
            s.groupName === s.memberName
              ? s.groupName
              : `${s.groupName}.${s.memberName}`,
          );
        }
      }
    }

    // Fill display names + the authoritative owner pluginId (the node whose
    // barrel produced these runtime contributions) into already-extracted data.
    for (const node of tree.byDir.values()) {
      const data = getFacet(node, contributionsFacetDef);
      if (!data || data.runtime.length === 0) continue;
      for (const c of data.runtime) {
        // Display names come from the slots facet — web slot contributions only.
        // A server `slotId` (a registry token like "page.block-data") must never
        // collide with a web `SlotDef.slotId`, so it stays undefined and renderDoc
        // falls back to the raw token.
        if (c.kind === "slot" && !c.slotDisplayName) {
          c.slotDisplayName = slotDisplayNames.get(c.slotId);
        }
        c.pluginId = node.id;
      }
    }

    // Resolve every `Pane.Register({ pane })` to the pane's id. This is a join,
    // and it lives here because `relate()` is the only place the whole tree is
    // in scope — `ExtractContext` carries a `dir` and no root.
    //
    // Pane identity stopped being local to the registering plugin's `web/` the
    // moment `Pane.define({ route })` arrived: the id is on a `defineRoute()`
    // that usually sits in another plugin's `core/`. It was already not local
    // before that — `settings/accounts` registers `auth`'s `accountsPane` — so
    // the old per-`web/`-dir scan simply reported nothing for it.
    fillPaneIds(tree);

    // Link each static contribution back to the plugin that defines its slot
    // (used by the detail PluginLink). The slots facet's runtime walk now
    // discovers every slot (including factory-produced ones at any nesting
    // depth), so all slot groups resolve their contribution owners here.
    const slotGroupToOwner = new Map<string, PluginNode>();
    for (const info of tree.byDir.values()) {
      const nodeSlots = getFacet(info, slotsFacetDef) ?? [];
      for (const slot of nodeSlots) {
        if (!slotGroupToOwner.has(slot.groupName)) {
          slotGroupToOwner.set(slot.groupName, info);
        }
      }
    }
    for (const contributor of tree.byDir.values()) {
      const data = getFacet(contributor, contributionsFacetDef);
      if (!data) continue;
      for (const c of data.static) {
        const head = c.slot.split(".")[0];
        if (!head) continue;
        const owner = slotGroupToOwner.get(head);
        if (!owner || owner === contributor) continue;
        c.definerPluginId = owner.id;
      }
    }

    // Per-slot reverse index: fill each `SlotDef.contributors` (full plugin ids)
    // with every node that contributes to that specific slot. This lives here —
    // not on the slots facet — because the join needs both facets in scope and
    // `slots/facet` importing `contributions/core` would close a collected-dir
    // dependency cycle (`contributions` already `dependsOn` `slots`). Read only
    // the contributions *extract* output (`data.static` / `data.runtime`); the
    // contributor is always the iterating node's `id`.
    //  - Runtime contributions: exact `slotId` match (authoritative, precise).
    //  - Static contributions: group head + last segment, robust for flat
    //    (`PluginView.Section`), nested (`Sonata.Toolbar.Start` → `Sonata.Start`),
    //    and single-member (`group === member`) symbols.
    const slotById = new Map<string, SlotDef[]>();
    const slotByGroupMember = new Map<string, SlotDef[]>();
    for (const node of tree.byDir.values()) {
      const nodeSlots = getFacet(node, slotsFacetDef) ?? [];
      for (const slot of nodeSlots) {
        slot.contributors = [];
        let byId = slotById.get(slot.slotId);
        if (!byId) slotById.set(slot.slotId, (byId = []));
        byId.push(slot);
        const key = `${slot.groupName}.${slot.memberName}`;
        let byGm = slotByGroupMember.get(key);
        if (!byGm) slotByGroupMember.set(key, (byGm = []));
        byGm.push(slot);
      }
    }

    const contributorsBySlot = new Map<SlotDef, Set<string>>();
    const record = (slot: SlotDef, id: string): void => {
      let set = contributorsBySlot.get(slot);
      if (!set) contributorsBySlot.set(slot, (set = new Set()));
      set.add(id);
    };
    for (const node of tree.byDir.values()) {
      const data = getFacet(node, contributionsFacetDef);
      if (!data) continue;
      for (const c of data.runtime) {
        if (c.kind !== "slot") continue;
        for (const slot of slotById.get(c.slotId) ?? []) record(slot, node.id);
      }
      for (const c of data.static) {
        const parts = c.slot.split(".");
        const head = parts[0];
        const last = parts[parts.length - 1];
        if (!head || !last) continue;
        for (const slot of slotByGroupMember.get(`${head}.${last}`) ?? [])
          record(slot, node.id);
      }
    }
    for (const [slot, set] of contributorsBySlot) {
      slot.contributors = [...set].sort();
    }
  },

  renderDoc(data: ContributionsFacetData) {
    const facts: DocFact[] = [];
    const web = data.runtime.filter((c) => c.kind === "slot");
    const server = data.runtime.filter((c) => c.kind === "server");
    if (web.length > 0)
      facts.push({
        folder: "web",
        key: "Contributes",
        noun: "contributions",
        groups: renderGroups(web),
      });
    if (server.length > 0)
      facts.push({
        folder: "server",
        key: "Contributes",
        noun: "contributions",
        groups: renderGroups(server),
      });
    return facts;
  },
});

/**
 * The plugin a name imported through `spec` belongs to, or `null` when the
 * specifier names no plugin in this tree.
 *
 * A relative specifier resolves to the referring plugin itself: relative `../`
 * escapes into another plugin's tree are forbidden (the plugin-boundaries
 * check's R10), so a `./routes` or `../core` can only ever be this plugin's own
 * file. An absent specifier means the name was declared in the referring file.
 */
function ownerOf(
  tree: PluginTree,
  from: PluginNode,
  spec: string | undefined,
): PluginNode | null {
  if (!spec || spec.startsWith(".")) return from;
  return resolvePluginSpecifier(tree, spec)?.node ?? null;
}

/**
 * The id of the route a `Pane.define({ route })` names, or undefined when the
 * reference cannot be resolved from source.
 *
 * A binding name declared once in the owning plugin is the whole story. Declared
 * twice under the same name in two of its files, the answer is ambiguous — and
 * an ambiguous answer is no answer, never a coin-flip between two ids, since the
 * consequence of guessing wrong is a table row attributing a pane to the wrong
 * id rather than to none.
 */
function routeIdOf(
  tree: PluginTree,
  from: PluginNode,
  ref: SourceRef,
): string | undefined {
  const owner = ownerOf(tree, from, ref.module);
  if (!owner) return undefined;
  const named = (getFacet(owner, contributionsFacetDef)?.routes ?? []).filter(
    (r) => r.name === ref.name,
  );
  if (named.length === 0) return undefined;
  const ids = new Set(named.map((r) => r.routeId));
  return ids.size === 1 ? named[0]!.routeId : undefined;
}

/**
 * Fill `paneId` on every `Pane.Register` static contribution, following the two
 * hops a pane's identity can take: the registering barrel → the plugin whose
 * `web/` defines the pane → the plugin whose source declares its route.
 */
function fillPaneIds(tree: PluginTree): void {
  for (const node of tree.byDir.values()) {
    const data = getFacet(node, contributionsFacetDef);
    if (!data) continue;
    for (const c of data.static) {
      if (c.slot !== "Pane.Register") continue;
      const local = c.props["pane"]?.trim();
      if (!local) continue;
      // No recorded ref ⇒ the pane variable is not imported into the barrel, so
      // it is defined in this plugin's own `web/` under that very name.
      const ref = data.paneRefs[local] ?? { name: local };
      const owner = ownerOf(tree, node, ref.module);
      if (!owner) continue;
      const pane = (getFacet(owner, contributionsFacetDef)?.panes ?? []).find(
        (p) => p.name === ref.name,
      );
      if (!pane) continue;
      // An inline `route: defineRoute({ id })` already carries the id — the route
      // has no binding, so there is nothing left to look up. A `route:` naming a
      // hoisted binding is a reference, and that route's own id IS the pane id,
      // sometimes from another plugin entirely.
      const id = pane.id ?? (pane.route && routeIdOf(tree, owner, pane.route));
      if (id) c.paneId = id;
    }
  }
}

/** One contribution, one line — the long-standing format. */
const fmt = (c: DocMetaContribution): string => {
  const parts = [`\`${c.slotDisplayName ?? c.slotId}\``];
  if (c.doc.label) parts.push(`"${c.doc.label}"`);
  if (c.doc.detail) parts.push(`(${c.doc.detail})`);
  if (c.componentName) parts.push(`→ \`${c.componentName}\``);
  return parts.join(" ");
};

/** The slot key a contribution renders under — what groups a run together. */
const slotKeyOf = (c: DocMetaContribution): string =>
  c.slotDisplayName ?? c.slotId;

/** Whether a contribution's only distinguishing content is its label. */
const isLabelOnly = (c: DocMetaContribution): boolean =>
  typeof c.doc.label === "string" &&
  c.doc.label.length > 0 &&
  !c.doc.detail &&
  !c.componentName;

/**
 * One runtime's contributions, one line each, grouped by slot — so the doc can
 * summarize a long list as one count per slot (reorder mints ~226 config
 * directives into one slot, sonata ~127 instruments).
 *
 * Groups keep their first member's position, and members their declared order:
 * the output reflects what the plugin declares, not a re-ordering the renderer
 * invented. The exception is a group of label-only entries, which denotes a SET
 * and is spelled sorted: its array order is a runtime DECLARATION order (reorder
 * mints one config directive per reorderable slot from a
 * `subscribeSlotsDeclared` callback, in whatever order barrels happened to be
 * imported in that process), which is not stable across processes. Unsorted,
 * the generated doc stops being a pure function of the checkout:
 * `plugins-doc-in-sync` passes when run alone and FAILS inside a full
 * check/build run, on bytes that record process history rather than any edit.
 */
function renderGroups(contributions: DocMetaContribution[]): DocFactGroup[] {
  const groups = new Map<string, DocMetaContribution[]>();
  for (const c of contributions) {
    const key = slotKeyOf(c);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    group.push(c);
  }
  return [...groups].map(([key, group]) => {
    const values = group.map(fmt);
    if (group.every(isLabelOnly)) values.sort();
    return { label: `\`${key}\``, values };
  });
}
