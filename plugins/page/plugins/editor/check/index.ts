import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { existsSync } from "fs";
import { join } from "path";
import { buildEnrichedTree } from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { contributionsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";
import {
  importBarrel,
  registerBarrelStubs,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import {
  conversionPrefixesOf,
  markdownLineClaim,
  markdownParseTagNames,
  type BlockHandle,
  type MarkdownContext,
} from "../core";
import {
  collectBlockHandles,
  resolveBlockSlots,
  WEB_BLOCK_FRAME_SLOT,
  WEB_BLOCK_SLOT,
} from "../core/testing";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import noTokenIdentityOutsideOwner from "./no-token-identity-outside-owner";

// The SERVER half's canonical slot token (see
// plugins/page/plugins/editor/server/internal/block-registry.ts). Both sides
// carry the block TYPE as their contribution's doc label — web
// `docLabel: (c) => c.block?.type`, server `docLabel: (h) => h.type` — which is
// the join key the first check below is built on. The two WEB tokens, and the
// slot-object resolution they feed, live beside the handle loader in
// `../core/testing/block-handles.ts`.
const SERVER_BLOCK_DATA_SLOT = "page.block-data"; // Editor.BlockData (server _kind)

// The `editor` plugin ITSELF registers `Editor.BlockData("page")` (page rows are
// written by editor server code directly, so page creation must not depend on the
// sub-page renderer). We therefore ALWAYS expect "page" in the server set — its
// absence means barrel import saw no BlockData contributions at all, i.e. the
// server scan silently degraded. Used as a health canary, not a hardcoded rule.
const CANARY_SERVER_TYPE = "page";

// Server `Editor.BlockData` contributions are now read off the SAME contributions
// facet as the web `Editor.Block` half (see the loop below). The facet's runtime
// extractor captures server registrations — `defineServerContribution` marks each
// with a `_kind` SYMBOL whose description is the registry token — as
// `{ kind: "server", slotId: <token>, doc.label: <type> }`, exactly mirroring how
// web slot contributions surface as `{ kind: "slot", … }`. The former reflective
// barrel-import workaround is gone: both sides of the invariant come from one tree.
const check: Check = {
  id: "page.editor:block-data-registered",
  description:
    "every block TYPE rendered on the web (`Editor.Block`) also has a server-side `data` schema (`Editor.BlockData`), so the write boundary can validate its data",
  async run(): Promise<CheckResult> {
    const root = await getWorktreeRoot();

    // The barrel-imported ("enriched") tree — the same tree docgen renders the
    // `Contributes: Editor.Block "<type>" → …` lines from. Its contributions
    // facet carries each web contribution's resolved doc label (the block type),
    // which a static source scan (banned by `no-adhoc-marker-scan`) could not
    // recover from `Editor.Block({ match: fooBlock.type, … })`. Memoized per-root.
    const tree = await buildEnrichedTree(root);

    // The invariant is keyed on the block TYPE, not the plugin: a type's web
    // renderer and its server schema may live in DIFFERENT plugins. `page` is
    // the one real case today — `sub-page` contributes the web `Editor.Block`
    // renderer for type "page", while the `editor` plugin itself owns the server
    // `Editor.BlockData("page")` registration. Keying on the type means this
    // asymmetry needs no per-plugin exception/allowlist: "page" ∈ serverTypes
    // automatically covers sub-page's web contribution.
    const webTypeToPlugins = new Map<string, string[]>();
    const serverTypes = new Set<string>();
    for (const node of tree.byDir.values()) {
      const facet = getFacet(node, contributionsFacetDef);
      if (!facet) continue;
      for (const c of facet.runtime) {
        if (c.kind === "slot" && c.slotId === WEB_BLOCK_SLOT) {
          const type = c.doc.label;
          if (!type) continue;
          const list = webTypeToPlugins.get(type) ?? [];
          list.push(node.id);
          webTypeToPlugins.set(type, list);
        } else if (c.kind === "server" && c.slotId === SERVER_BLOCK_DATA_SLOT) {
          const type = c.doc.label;
          if (type) serverTypes.add(type);
        }
      }
    }

    // Fail LOUD if either side's data is missing rather than pass vacuously.
    // Empty web set ⇒ the contributions facet silently degraded; missing canary
    // ⇒ the server barrel scan silently degraded. Either way the invariant was
    // NOT verified — a tooling failure, not a clean pass, which must never let an
    // unregistered block type slip through to a user's first insert 400ing.
    if (webTypeToPlugins.size === 0) {
      return {
        ok: false,
        message:
          "No web `Editor.Block` contributions found in the enriched plugin tree — " +
          "the barrel-imported contributions facet is empty, so the web↔server block-type " +
          "invariant could not be verified. This is a check/tooling failure, not a clean pass.",
      };
    }
    if (!serverTypes.has(CANARY_SERVER_TYPE)) {
      return {
        ok: false,
        message:
          `The editor's own \`Editor.BlockData("${CANARY_SERVER_TYPE}")\` registration was not ` +
          "observed while scanning server barrels — the server-side contribution scan silently " +
          "degraded, so the web↔server block-type invariant could not be verified. This is a " +
          "check/tooling failure, not a clean pass.",
      };
    }

    const missing = [...webTypeToPlugins.entries()]
      .filter(([type]) => !serverTypes.has(type))
      .sort(([a], [b]) => a.localeCompare(b));

    if (missing.length === 0) return { ok: true };

    const lines = missing.map(
      ([type, plugins]) =>
        `  block type "${type}" (web renderer contributed by: ${[...new Set(plugins)].sort().join(", ")}) ` +
        `has no server \`Editor.BlockData\` registration`,
    );
    return {
      ok: false,
      message:
        `${missing.length} block type(s) rendered on the web have no server \`data\` schema, so the ` +
        `write boundary (POST /api/blocks …) cannot validate their data:\n${lines.join("\n")}`,
      hint:
        "Add a one-line server barrel that contributes the block's handle:\n" +
        "  // plugins/page/plugins/<type>/server/index.ts\n" +
        '  import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";\n' +
        '  import { Editor } from "@plugins/page/plugins/editor/server";\n' +
        '  import { <handle> } from "../core";\n' +
        '  export default { description: "…", contributions: [Editor.BlockData(<handle>)] } satisfies ServerPluginDefinition;\n' +
        "then run `./equin build`. See plugins/page/plugins/text/server/index.ts for the precedent. " +
        '(The "page" type is registered by the editor plugin itself, not by its web renderer sub-page.)',
    };
  },
};

/**
 * A container ANCHOR's two halves must agree.
 *
 * `BlockHandle.anchor: true` lives in `core` because the pure REDUCER needs it
 * (the empty-anchor prune, the split/merge refusals) and the server has no
 * slots. The DECORATION it implies — the glyph the surface paints in the indent
 * gutter — is a React component, so it rides on the web `Editor.BlockFrame`
 * contribution (see `web/slots.ts` for why it rides there and not on a slot of
 * its own). Two declarations, each where it is needed, and nothing in the type
 * system ties them together.
 *
 * A handle claiming anchorhood with no decoration is not cosmetic: the reducer
 * treats the type as a void container (its row renders no line, and while it has
 * visible children the surface collapses that row to ZERO height), while the
 * surface paints nothing into the column — an invisible container. This check is
 * what stops the two from silently disagreeing.
 *
 * Both facts are read by IMPORTING the same web barrels the docgen tree already
 * imports (a static source scan cannot recover `anchor` off
 * `Editor.Block({ match: fooBlock.type, block: fooBlock })`, and ad-hoc marker
 * scanning is banned outright). The barrel module is Bun-cached, so re-importing
 * after `buildEnrichedTree` costs nothing.
 */
const anchorHasDecoration: Check = {
  id: "page-editor:anchor-has-decoration",
  description:
    "every block handle declaring `anchor: true` has a matching `anchor` component on its plugin's `Editor.BlockFrame` contribution",
  async run(): Promise<CheckResult> {
    const root = await getWorktreeRoot();
    const tree = await buildEnrichedTree(root);
    registerBarrelStubs(root);

    const slots = await resolveBlockSlots(root);
    if (!slots.ok) return slots;

    // Only plugins that actually contribute a block renderer can declare a
    // handle, so the candidate set comes from the contributions facet rather
    // than a directory sweep — a block type living outside `plugins/page` is
    // covered for free.
    const candidateDirs = new Set<string>();
    for (const [dir, node] of tree.byDir) {
      const facet = getFacet(node, contributionsFacetDef);
      if (!facet) continue;
      for (const c of facet.runtime) {
        if (
          c.kind === "slot" &&
          (c.slotId === WEB_BLOCK_SLOT || c.slotId === WEB_BLOCK_FRAME_SLOT)
        ) {
          // A web slot contribution can only have come from a web barrel; the
          // guard is belt-and-braces so a tree oddity cannot turn into a throw.
          if (existsSync(join(dir, "web", "index.ts"))) candidateDirs.add(dir);
          break;
        }
      }
    }

    if (candidateDirs.size === 0) {
      return {
        ok: false,
        message:
          "No web `Editor.Block` / `Editor.BlockFrame` contributions found in the enriched plugin " +
          "tree — the barrel-imported contributions facet is empty, so the anchor↔decoration " +
          "invariant could not be verified. This is a check/tooling failure, not a clean pass.",
      };
    }

    // type -> the plugin ids declaring `anchor: true` on its handle.
    const anchorTypes = new Map<string, string[]>();
    // types whose `Editor.BlockFrame` contribution supplies a decoration — in
    // EITHER seat. Which seat a container asks for says what its decoration is
    // (a glyph leading its first line, or its name in the box's corner), and
    // that is a design choice; what this check pins is that it asked for one at
    // all, since a container with none is invisible whichever seat it declined.
    const decorated = new Set<string>();

    for (const dir of candidateDirs) {
      const mod = await importBarrel(join(dir, "web", "index.ts"));
      const def = mod.default as { contributions?: unknown } | undefined;
      const contributions = def?.contributions;
      if (!Array.isArray(contributions)) continue;
      for (const raw of contributions) {
        const c = raw as {
          _slot?: SlotHandle;
          match?: unknown;
          anchor?: unknown;
          cornerAnchor?: unknown;
          block?: { type?: unknown; anchor?: unknown };
        };
        if (c._slot === slots.block) {
          const type = c.block?.type;
          if (typeof type === "string" && c.block?.anchor === true) {
            const list = anchorTypes.get(type) ?? [];
            list.push(tree.byDir.get(dir)?.id ?? dir);
            anchorTypes.set(type, list);
          }
        } else if (c._slot === slots.frame) {
          if (typeof c.match === "string" && (c.anchor || c.cornerAnchor))
            decorated.add(c.match);
        }
      }
    }

    const missing = [...anchorTypes.entries()]
      .filter(([type]) => !decorated.has(type))
      .sort(([a], [b]) => a.localeCompare(b));

    if (missing.length === 0) return { ok: true };

    const lines = missing.map(
      ([type, plugins]) =>
        `  block type "${type}" (declared by: ${[...new Set(plugins)].sort().join(", ")}) ` +
        "declares `anchor: true` but contributes no `anchor` / `cornerAnchor` component on " +
        "`Editor.BlockFrame`",
    );
    return {
      ok: false,
      message:
        `${missing.length} anchor block type(s) render no decoration, so their container is ` +
        `invisible (the row collapses to zero height and nothing paints the gutter column):\n${lines.join("\n")}`,
      hint:
        "Add the decoration to the SAME `Editor.BlockFrame` contribution that makes the type a " +
        "container, in whichever of the two seats fits what the decoration IS:\n" +
        "  Editor.BlockFrame({ match: <handle>.type, component: <Frame>, anchor: <Glyph> })\n" +
        "    — a mark leading the card's first line (the callout's icon), or\n" +
        "  Editor.BlockFrame({ match: <handle>.type, component: <Frame>, cornerAnchor: <Name> })\n" +
        "    — the card's own name in the box's top-right corner, revealed on hover.\n" +
        "Either component takes `BlockAnchorProps` ({ type, data, editor? }) and renders " +
        "APPEARANCE only — the surface owns its position, and the structural actions live on " +
        "the rail of the line the container borrows. Alternatively drop " +
        "`anchor: true` from the handle if the type really does render its own line.",
    };
  },
};

/**
 * At most ONE block type may own a markdown tag name on the parse side.
 *
 * A tag name is how `parseMarkdownToForest` routes `<name …>` back to a type, so
 * two claimants have no resolution — the parser throws, and it throws on the
 * user's PASTE rather than at build time. The live hazard is `page`, which two
 * handles register (the editor's own for the server write boundary, `sub-page`'s
 * for the web renderer) while `page-link` owns `<page>` on parse: any of the
 * three dropping `serializeOnly`, or a new type picking a taken name, breaks
 * every markdown paste. Since `page` is also SPELLED two ways (`<page>` for a
 * human's sub-page, `<agent-page>` for an agent-authored one), every spelling a
 * handle claims is a name here.
 *
 * `markdownParseTagNames` is the SAME resolution the runtime uses, imported
 * rather than restated, so the check cannot drift from what it checks.
 */
const markdownTagNamesUnique: Check = {
  id: "page.editor:markdown-tag-names-unique",
  description:
    "at most one block handle claims each markdown tag name on parse (`markdown.tag.serializeOnly` opts the others out)",
  async run(): Promise<CheckResult> {
    const root = await getWorktreeRoot();
    const tree = await buildEnrichedTree(root);
    registerBarrelStubs(root);

    const slots = await resolveBlockSlots(root);
    if (!slots.ok) return slots;

    const candidateDirs = new Set<string>();
    for (const [dir, node] of tree.byDir) {
      const facet = getFacet(node, contributionsFacetDef);
      if (!facet) continue;
      for (const c of facet.runtime) {
        if (c.kind === "slot" && c.slotId === WEB_BLOCK_SLOT) {
          if (existsSync(join(dir, "web", "index.ts"))) candidateDirs.add(dir);
          break;
        }
      }
    }
    if (candidateDirs.size === 0) {
      return {
        ok: false,
        message:
          "No web `Editor.Block` contributions found in the enriched plugin tree — the " +
          "barrel-imported contributions facet is empty, so tag-name uniqueness could not be " +
          "verified. This is a check/tooling failure, not a clean pass.",
      };
    }

    // tag name -> "<plugin id> (<block type>)" for each claimant.
    const claimants = new Map<string, string[]>();
    for (const dir of candidateDirs) {
      const mod = await importBarrel(join(dir, "web", "index.ts"));
      const def = mod.default as { contributions?: unknown } | undefined;
      if (!Array.isArray(def?.contributions)) continue;
      for (const raw of def.contributions) {
        const c = raw as { _slot?: SlotHandle; block?: BlockHandle<unknown> };
        if (c._slot !== slots.block || !c.block) continue;
        // Every spelling the handle claims (`markdown.tag.spellings`): a second
        // spelling is a second NAME, and each name is one claim.
        for (const name of markdownParseTagNames(c.block)) {
          const list = claimants.get(name) ?? [];
          list.push(`${tree.byDir.get(dir)?.id ?? dir} (${c.block.type})`);
          claimants.set(name, list);
        }
      }
    }

    const conflicts = [...claimants.entries()]
      .filter(([, list]) => new Set(list).size > 1)
      .sort(([a], [b]) => a.localeCompare(b));
    if (conflicts.length === 0) return { ok: true };

    return {
      ok: false,
      message:
        `${conflicts.length} markdown tag name(s) are claimed by more than one block type, so ` +
        `every markdown paste would throw:\n${conflicts
          .map(
            ([name, list]) =>
              `  <${name}> ← ${[...new Set(list)].sort().join(", ")}`,
          )
          .join("\n")}`,
      hint:
        "Either rename one type's tag (`markdown.tag.name`, or a spelling's name), or mark the " +
        "one that only EMITS it as `markdown.tag.serializeOnly: true` — the way `page`'s primary " +
        "spelling does, so `<page id=…/>` serializes from a sub-page and parses back as a " +
        "`page-link`.",
    };
  },
};

/**
 * A declared SPLIT TARGET must be a text-bearing type.
 *
 * `applySplit` writes the post-caret runs onto the tail row it mints, whose type
 * is `op.siblingType ?? block.type` (from `BlockHandle.splitInto`) or
 * `op.childType ?? block.type` (from `splitChildWhenExpanded.childType`). Point
 * either at a void type and every Enter in that block writes `data.text` onto a
 * schema that has no `text` key — a 400 at the write boundary, on a keystroke.
 *
 * A CHECK rather than a reducer refusal, because unlike the merge target (which
 * is whatever row happens to sit above the caret, and so is refused at runtime
 * in `applyMerge`) the split target is DECLARED: the set is closed at build
 * time, so the strongest form the constraint can take is a build failure rather
 * than a keystroke that silently does nothing.
 */
const splitTargetsAreTextBearing: Check = {
  id: "page.editor:split-targets-are-text-bearing",
  description:
    "every declared split target (`splitInto`, `splitChildWhenExpanded.childType`) names a text-bearing block type, so the tail row the reducer mints can carry the text it splits off",
  async run(): Promise<CheckResult> {
    const collected = await collectBlockHandles();
    if (!collected.ok) {
      return {
        ok: false,
        message:
          "No block handles could be read, so split targets were NOT verified — " +
          `${collected.reason} This is a check/tooling failure, not a clean pass.`,
      };
    }

    const textBearing = new Set(
      collected.handles
        .filter((h) => h.handle.acceptsText)
        .map((h) => h.handle.type),
    );
    const known = new Set(collected.handles.map((h) => h.handle.type));

    const bad: string[] = [];
    for (const { pluginId, handle } of collected.handles) {
      const targets: [string, string][] = [];
      if (handle.splitInto) targets.push(["splitInto", handle.splitInto]);
      if (handle.splitChildWhenExpanded) {
        targets.push([
          "splitChildWhenExpanded.childType",
          handle.splitChildWhenExpanded.childType,
        ]);
      }
      for (const [field, target] of targets) {
        // An UNKNOWN target is a different defect (a typo'd or removed type) and
        // is reported as its own line rather than folded into "not text-bearing",
        // which would send the reader looking at the wrong schema.
        if (!known.has(target)) {
          bad.push(
            `  "${handle.type}" (${pluginId}) declares \`${field}: "${target}"\`, but no block ` +
              "type by that name is registered",
          );
        } else if (!textBearing.has(target)) {
          bad.push(
            `  "${handle.type}" (${pluginId}) declares \`${field}: "${target}"\`, but "${target}" ` +
              "is a void type — its schema has no `text` key",
          );
        }
      }
    }

    if (bad.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        `${bad.length} declared split target(s) cannot hold the text a split hands them, so every ` +
        `Enter in the declaring block would 400 at the write boundary:\n${bad.join("\n")}`,
      hint:
        "Point the target at a text-bearing type (`page/text` is what every current declaration " +
        "uses). A void type cannot be a split target at all: splitting means moving the runs after " +
        "the caret into the new row, and a type whose schema declares no `text` has nowhere to put " +
        "them.",
    };
  },
};

/**
 * At most ONE block type may declare any given conversion prefix.
 *
 * `MarkdownShortcutPlugin` flattens every handle's prefixes into one
 * longest-first list and converts on the FIRST match, so a duplicated prefix
 * resolves by registration order — i.e. by nothing the author of either block
 * type controls, and silently. Typing `> ` would mint a toggle or a quote
 * depending on which plugin the registry happened to walk first, and the loser's
 * shortcut would simply never fire.
 *
 * The union is read through `conversionPrefixesOf`, the SAME resolution the
 * runtime uses, so the check cannot drift from what it checks — both prefix
 * fields are covered, and a prefix moved between them stays covered.
 */
const blockPrefixesUnique: Check = {
  id: "page.editor:block-prefixes-unique",
  description:
    "no two block handles declare the same conversion prefix (`markdownPrefixes` ∪ `typingPrefixes`), which the typing shortcut would resolve by registration order",
  async run(): Promise<CheckResult> {
    const collected = await collectBlockHandles();
    if (!collected.ok) {
      return {
        ok: false,
        message:
          "No block handles could be read, so prefix uniqueness was NOT verified — " +
          `${collected.reason} This is a check/tooling failure, not a clean pass.`,
      };
    }

    // prefix -> "<plugin id> (<block type>)" for each declaring handle.
    const claimants = new Map<string, string[]>();
    for (const { pluginId, handle } of collected.handles) {
      for (const prefix of conversionPrefixesOf(handle)) {
        const list = claimants.get(prefix) ?? [];
        list.push(`${pluginId} (${handle.type})`);
        claimants.set(prefix, list);
      }
    }

    const conflicts = [...claimants.entries()]
      .filter(([, list]) => new Set(list).size > 1)
      .sort(([a], [b]) => a.localeCompare(b));
    if (conflicts.length === 0) return { ok: true };

    return {
      ok: false,
      message:
        `${conflicts.length} conversion prefix(es) are declared by more than one block type, so ` +
        `which one a user's keystroke converts into is decided by registration order:\n${conflicts
          .map(
            ([prefix, list]) =>
              `  "${prefix}" ← ${[...new Set(list)].sort().join(", ")}`,
          )
          .join("\n")}`,
      hint:
        "Give one of the types a different prefix. A prefix is a scarce, global namespace: `> ` " +
        "belongs to `toggle`, which is why `quote` types with `| ` instead. If the prefix is real " +
        "markdown line syntax it belongs on `markdownPrefixes`; if it only converts when TYPED " +
        "(`| `, `[] `, ```` ``` ````) it belongs on `typingPrefixes` — but either way, only once.",
    };
  },
};

/**
 * Every line a block type CLAIMS is really claimed by it, and one leading
 * backslash defeats every claimer.
 *
 * The serializer escapes a paragraph whose words open like another type's line
 * (`\3. x`) by asking who would claim the line it just wrote and putting ONE
 * backslash at index 0. Two facts have to hold for that to be a round trip, and
 * neither is stated anywhere a type can see:
 *
 * - **A declared sample is claimed by its declarer.** A `markdownPrefixes` entry
 *   IS its own declaration (`prefix + "x"` is a sample of it), but a hand-written
 *   `markdown.parseLine` is a closure nobody can enumerate — so it declares the
 *   lines it takes as `parseLine.claims`, and a sample its own declarer does not
 *   claim is a lie in the declaration. This also pins the PRECEDENCE order, which
 *   nothing else checks: `- [ ] x` is `to-do`'s sample and `- ` is
 *   `bulleted-list`'s prefix, so the two really do overlap, and the only thing
 *   deciding it is `markdown.precedence`.
 * - **`"\\" + sample` is claimed by nobody.** This is the escape's correctness
 *   proof and the one fact `markdownPrefixes` cannot yield: every claimer either
 *   anchors at `^` or compares `trim()`, but that is a property of each regex
 *   rather than something declared, so it is asserted over the real set.
 *
 * `markdownLineClaim` is the SAME authority both directions of the round trip
 * run — the serializer's escape probe and the parser's dispatch — imported
 * rather than restated, so the check cannot drift from what it checks.
 */
const markdownClaimsAreEscapable: Check = {
  id: "page.editor:markdown-claims-are-escapable",
  description:
    "every line a block type declares it claims (`markdown.parseLine.claims`, `markdown.lineRun.claims`, `markdownPrefixes`) is claimed by that type, and stops being claimed once escaped with one leading backslash",
  async run(): Promise<CheckResult> {
    const collected = await collectBlockHandles();
    if (!collected.ok) {
      return {
        ok: false,
        message:
          "No block handles could be read, so markdown line claims were NOT verified — " +
          `${collected.reason} This is a check/tooling failure, not a clean pass.`,
      };
    }

    // The three dialect fields are inert for a claim question and are picked to
    // match the round trip's own document anyway. A claim never reaches them:
    // `blankLines` decides what an EMPTY line parses as, `emptyBlocks` and
    // `softBreaks` are read on SERIALIZE only, and the claim probe runs against
    // the module's own stub parse context, so `protectedSpans` is never read
    // either (it only ever feeds `ctx.runs`, which a claimant fills its text
    // from after it has already decided).
    const ctx: MarkdownContext = {
      handles: collected.handles.map((h) => h.handle),
      protectedSpans: [],
      blankLines: "empty-block",
      emptyBlocks: "pinned",
      softBreaks: "escaped",
    };

    // Every sample, with the field that declared it — the two forms fail for
    // different reasons and the reader has to be sent to the right one.
    const samples: {
      pluginId: string;
      type: string;
      field: string;
      line: string;
    }[] = [];
    for (const { pluginId, handle } of collected.handles) {
      for (const line of handle.markdown?.parseLine?.claims ?? [])
        samples.push({
          pluginId,
          type: handle.type,
          field: "markdown.parseLine.claims",
          line,
        });
      for (const line of handle.markdown?.lineRun?.claims ?? [])
        samples.push({
          pluginId,
          type: handle.type,
          field: "markdown.lineRun.claims",
          line,
        });
      for (const prefix of handle.markdownPrefixes ?? [])
        samples.push({
          pluginId,
          type: handle.type,
          field: "markdownPrefixes",
          line: `${prefix}x`,
        });
    }

    // No sample at all is the same degradation as no handles, one level down:
    // every claiming type would have had to drop both declarations at once, and
    // the loop below would then verify nothing while reporting a clean pass.
    if (samples.length === 0) {
      return {
        ok: false,
        message:
          `${collected.handles.length} block handle(s) were read, but not one of them declares a ` +
          "line it claims (`markdown.parseLine.claims` / `markdown.lineRun.claims` / " +
          "`markdownPrefixes`), so the escape was " +
          "NOT verified. This is a check/tooling failure, not a clean pass.",
      };
    }

    // Report EVERY failing sample, not the first: a precedence change breaks a
    // whole family at once, and a reader fixing them one run at a time is being
    // told a quarter of the story per run.
    const bad: string[] = [];
    for (const { pluginId, type, field, line } of samples) {
      const claimant = markdownLineClaim(line, ctx);
      if (claimant !== type) {
        bad.push(
          `  "${line}" is declared by "${type}" (${pluginId}, \`${field}\`), but ` +
            (claimant === undefined
              ? "nothing claims it — it parses back as an ordinary paragraph"
              : `"${claimant}" claims it`),
        );
      }
      const escaped = markdownLineClaim(`\\${line}`, ctx);
      if (escaped !== undefined) {
        bad.push(
          `  "\\${line}" (the escaped form of "${type}"'s sample, ${pluginId}, \`${field}\`) is ` +
            `still claimed, by "${escaped}"`,
        );
      }
    }

    if (bad.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        `${bad.length} markdown line claim(s) do not hold, so a paragraph opening with one of ` +
        `these lines cannot survive being written out and read back:\n${bad.join("\n")}`,
      hint:
        "A sample its declarer does not claim means the declaration and the parser disagree: " +
        "either the sample is wrong (fix the `claims` entry, or the `markdownPrefixes` entry it " +
        "was built from), or another type outranks this one and the two need a `markdown." +
        "precedence` between them (`to-do` sits above `bulleted-list` that way). An escaped " +
        "sample that is still claimed is the serious half: the serializer escapes a paragraph " +
        "opening with a claimed line by putting ONE backslash at index 0, so a claimer that " +
        "does not anchor at `^` (or compare `trim()`) silently steals the paragraph back and " +
        "the block loses its id, its content doc and its children on the way in.",
    };
  },
};

export default [
  check,
  anchorHasDecoration,
  markdownTagNamesUnique,
  blockPrefixesUnique,
  markdownClaimsAreEscapable,
  splitTargetsAreTextBearing,
  noTokenIdentityOutsideOwner,
];
