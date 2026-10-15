import { dirname, join } from "path";
import { existsSync } from "fs";
import {
  createFacet,
  getFacet,
  type DocFact,
} from "@plugins/plugin-meta/plugins/facets/core";
import type { PluginTree } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import { resolvePluginSpecifier } from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  RUNTIME_FOLDERS,
  SHIPPED_RUNTIME_FOLDERS,
  type PluginId,
  type RuntimeFolder,
  asPath,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  walkFiles,
  readIfExists,
  findImports,
  runWithFsSnapshot,
  type FsSnapshot,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import {
  tokenGroupsDeclaredIn,
  tokenVarsUsedBy,
  type SourceText,
} from "@plugins/plugin-meta/plugins/token-usage/core";
import {
  type CrossRefsData,
  type DeclaredTokenGroup,
  type RawUse,
  type TokenUse,
  crossRefsFacetDef,
} from "../core";

// ── Helpers ────────────────────────────────────────────────────────────

// Records every `@plugins/…` import in `runtimeDir` as a RawUse. No tree is
// available at extract() time, so we do NOT resolve, self-skip, or filter by
// runtime here — that happens in relate(). `findImports` masks comments/regex/
// strings and reads each specifier back by offset, so an import statement
// written inside a string or comment never registers a phantom use.
function parseRawUses(runtimeDir: string): RawUse[] {
  const files: string[] = [];
  walkFiles(runtimeDir, files);
  const uses: RawUse[] = [];
  const seen = new Set<string>();

  const add = (specifier: string, symbol?: string) => {
    const key = `${specifier}::${symbol ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    uses.push(symbol === undefined ? { specifier } : { specifier, symbol });
  };

  for (const f of files) {
    const raw = readIfExists(f);
    if (!raw) continue;
    for (const imp of findImports(raw)) {
      // The old namedRe/nsRe/defRe/sideRe were all `import`-only (never
      // `export … from`), and none of them ever matched a whole-statement
      // `import type …` (the leading `type` keyword breaks each pattern), so we
      // keep both filters to preserve behavior byte-for-byte.
      if (imp.keyword !== "import") continue;
      if (!imp.specifier.startsWith("@plugins/")) continue;
      if (imp.sideEffect) {
        add(imp.specifier); // bare `import "@plugins/…"` — mirrors old sideRe.
        continue;
      }
      if (imp.typeOnly) continue;
      const clause = imp.clause;
      // Namespace `import * as X` — a use of the plugin, no named symbol (nsRe).
      if (/^\s*\*\s+as\s+/.test(clause)) {
        add(imp.specifier);
        continue;
      }
      const braceIdx = clause.indexOf("{");
      if (braceIdx < 0) {
        // Default-only `import Foo from` — the whole clause is the local id (defRe).
        if (/^\s*[A-Za-z_$][\w$]*\s*$/.test(clause)) add(imp.specifier);
        continue;
      }
      // A default alongside named ones (`import Foo, { a, b } from …`) is a
      // default — record it without a symbol (mirrors the namedRe m[1] branch).
      if (/[A-Za-z_$][\w$]*\s*,/.test(clause.slice(0, braceIdx)))
        add(imp.specifier);
      const closeIdx = clause.indexOf("}", braceIdx);
      const names = clause.slice(
        braceIdx + 1,
        closeIdx < 0 ? clause.length : closeIdx,
      );
      for (const part of names.split(",")) {
        let s = part.trim();
        if (!s) continue;
        s = s.replace(/^type\s+/, "");
        const asMatch = s.match(/^(\w+)\s+as\s+\w+$/);
        const orig = asMatch ? asMatch[1]! : s;
        if (/^\w+$/.test(orig)) add(imp.specifier, orig);
      }
    }
  }
  return uses;
}

// The token groups a plugin declares: `defineTokenGroup` calls in its `core/`,
// the folder a group's descriptor lives in (its `web/` registers it).
function parseTokenGroups(coreDir: string): DeclaredTokenGroup[] {
  const files: string[] = [];
  walkFiles(coreDir, files);
  return files.flatMap((f) => tokenGroupsDeclaredIn(readIfExists(f) ?? "", f));
}

// The runtimes a page loads, where a word can be a Tailwind class. Elsewhere
// (a server, a data-dir declaration) only a literal `var(--x)` is a token use.
const STYLED_RUNTIME_FOLDERS: ReadonlySet<RuntimeFolder> = new Set([
  "web",
  "core",
  "shared",
]);

// What the plugin's SHIPPED source styles with: every `.ts`/`.tsx`/`.css`
// under the runtimes the deployed app runs — the same folders whose imports
// are hard edges (`classifyEdges`).
function shippedSources(dir: string): SourceText[] {
  const out: SourceText[] = [];
  for (const rt of SHIPPED_RUNTIME_FOLDERS) {
    const rtDir = join(dir, rt);
    if (!existsSync(rtDir)) continue;
    const files: string[] = [];
    walkFiles(rtDir, files, { css: true });
    for (const file of files)
      out.push({
        file,
        content: readIfExists(file) ?? "",
        classes: STYLED_RUNTIME_FOLDERS.has(rt),
      });
  }
  return out;
}

/**
 * `items` grouped by `labelOf`, each group at its first member's position. Both
 * lists this facet groups are sorted with the label as their prefix, so the
 * groups' concatenation is the input order.
 */
function groupInOrder<T>(
  items: readonly T[],
  labelOf: (item: T) => string,
): { label: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const label = labelOf(item);
    let group = groups.get(label);
    if (!group) groups.set(label, (group = []));
    group.push(item);
  }
  return [...groups].map(([label, grouped]) => ({ label, items: grouped }));
}

function emptyByRuntime<T>(): Record<RuntimeFolder, T[]> {
  const out = {} as Record<RuntimeFolder, T[]>;
  for (const rt of RUNTIME_FOLDERS) out[rt] = [];
  return out;
}

// ── Facet ──────────────────────────────────────────────────────────────

export default createFacet<CrossRefsData>({
  def: crossRefsFacetDef,

  extract(ctx) {
    const raw = emptyByRuntime<RawUse>();
    for (const rt of RUNTIME_FOLDERS) {
      const rtDir = join(ctx.dir, rt);
      if (existsSync(rtDir)) raw[rt] = parseRawUses(rtDir);
    }
    const coreDir = join(ctx.dir, "core");
    return {
      apiUses: emptyByRuntime(),
      importedBy: [],
      raw,
      tokenGroups: existsSync(coreDir) ? parseTokenGroups(coreDir) : [],
      tokenUses: [],
      tokenUsedBy: [],
    };
  },

  // Every var each plugin's shipped source reads, in ONE async pass over the
  // whole tree: the token scanner batches every plugin into a single Tailwind
  // extraction and yields while it compiles (see `tokenVarsUsedBy`).
  async prepareRelate(ctx: unknown) {
    const { tree, fs } = ctx as { tree: PluginTree; fs: FsSnapshot };
    const nodes = [...tree.byDir.values()].filter((node) =>
      getFacet(node, crossRefsFacetDef),
    );
    const sources = runWithFsSnapshot(fs, () =>
      nodes.map((node) => shippedSources(node.dir)),
    );
    const used = await tokenVarsUsedBy(dirname(tree.pluginsRoot), sources);
    nodes.forEach((node, i) => {
      getFacet(node, crossRefsFacetDef)!.rawVars = [...used[i]!];
    });
  },

  relate(ctx: unknown) {
    const { tree } = ctx as { tree: PluginTree };
    const byId = new Map(
      Array.from(tree.byDir.values()).map((node) => [node.id, node]),
    );

    // First pass — resolve each raw `@plugins/…` specifier into apiUses.
    for (const node of tree.byDir.values()) {
      const data = getFacet(node, crossRefsFacetDef);
      if (!data?.raw) continue;
      for (const rt of RUNTIME_FOLDERS) {
        const seen = new Set<string>();
        for (const use of data.raw[rt]) {
          const r = resolvePluginSpecifier(tree, use.specifier);
          // An unresolved @plugins/… import is either a genuine bug — already
          // caught loudly by `type-check` (tsc) and the boundary checker at
          // build/push time — or a transient artifact of building this tree at
          // runtime over a live, mid-mutation working dir: review.plugin-changes
          // diffs against the `main` checkout, which is half-written during a
          // `./singularity push` merge, and the studio/plugin-view panes read
          // live dirs too. A hard throw here turns that transient half-written
          // state into a resource-loader crash for an unrelated baseline tree,
          // so skip the use instead — the genuine-bug case still fails loudly at
          // its dedicated gates.
          if (!r) continue;
          if (r.node === node) continue; // self-skip
          if (r.suffix[0] !== rt) continue; // same-runtime filter
          const key = `${r.node.id}:${use.symbol ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          data.apiUses[rt].push({ plugin: r.node.id, symbol: use.symbol });
        }
      }
      // Clear the transient raw data so it doesn't leak into stored facet data.
      data.raw = undefined;
    }

    // Token pass — each var a plugin reads, resolved to the plugin whose token
    // group supplies it. A var two groups claim throws: which plugin paints it
    // would be a coin toss (`css-vars-single-owner` names the pair at check time).
    const owners = new Map<string, { plugin: PluginId; group: string }>();
    for (const node of tree.byDir.values()) {
      for (const group of getFacet(node, crossRefsFacetDef)?.tokenGroups ?? [])
        for (const v of group.vars) {
          const prior = owners.get(v);
          if (prior && prior.plugin !== node.id)
            throw new Error(
              `${v} is supplied by two token groups: "${prior.group}" (${asPath(prior.plugin)}) and "${group.id}" (${asPath(node.id)}).`,
            );
          owners.set(v, { plugin: node.id, group: group.id });
        }
    }
    for (const node of tree.byDir.values()) {
      const data = getFacet(node, crossRefsFacetDef);
      if (!data?.rawVars) continue;
      const byOwner = new Map<PluginId, TokenUse>();
      for (const v of data.rawVars) {
        const owner = owners.get(v);
        if (!owner || owner.plugin === node.id) continue;
        let use = byOwner.get(owner.plugin);
        if (!use)
          byOwner.set(
            owner.plugin,
            (use = { plugin: owner.plugin, group: owner.group, vars: [] }),
          );
        use.vars.push(v);
      }
      data.tokenUses = [...byOwner.values()]
        .map((use) => ({ ...use, vars: use.vars.sort() }))
        .sort((a, b) => a.plugin.localeCompare(b.plugin));
      data.rawVars = undefined;
      // An owner is a tree node by construction (`owners` was read off them).
      for (const use of data.tokenUses)
        getFacet(byId.get(use.plugin)!, crossRefsFacetDef)!.tokenUsedBy.push(
          node.id,
        );
    }

    // Second pass — invert apiUses into importedBy.
    for (const importer of tree.byDir.values()) {
      const data = getFacet(importer, crossRefsFacetDef);
      if (!data) continue;
      const referenced = new Set(
        RUNTIME_FOLDERS.flatMap((rt) => data.apiUses[rt].map((u) => u.plugin)),
      );
      for (const targetId of referenced) {
        const target = byId.get(targetId);
        if (!target || target === importer) continue;
        const td = getFacet(target, crossRefsFacetDef);
        if (td && !td.importedBy.includes(importer.id))
          td.importedBy.push(importer.id);
      }
    }

    // Stable output.
    for (const node of tree.byDir.values()) {
      const data = getFacet(node, crossRefsFacetDef);
      if (!data) continue;
      data.importedBy.sort();
      data.tokenUsedBy.sort();
      for (const rt of RUNTIME_FOLDERS)
        data.apiUses[rt].sort((a, b) =>
          `${a.plugin}:${a.symbol ?? ""}`.localeCompare(
            `${b.plugin}:${b.symbol ?? ""}`,
          ),
        );
    }
  },

  renderDoc(data) {
    const facts: DocFact[] = [];
    for (const rt of RUNTIME_FOLDERS) {
      if (data.apiUses[rt].length > 0) {
        // Grouped by the plugin used: summarized, a heavy consumer reads as
        // "which plugins, how many symbols each".
        facts.push({
          folder: rt,
          key: "Uses",
          noun: "symbols",
          groups: groupInOrder(
            data.apiUses[rt],
            (u) => `\`${asPath(u.plugin)}\``,
          ).map(({ label, items }) => ({
            label,
            values: items.map(
              (u) => `\`${asPath(u.plugin)}${u.symbol ? "." + u.symbol : ""}\``,
            ),
          })),
        });
      }
    }
    if (data.tokenUses.length > 0) {
      // Grouped by the owning plugin: which token groups this plugin paints with.
      facts.push({
        folder: "cross-plugin",
        key: "Uses tokens",
        noun: "vars",
        groups: data.tokenUses.map((use) => ({
          label: `\`${asPath(use.plugin)}\``,
          values: use.vars.map((v) => `\`${asPath(use.plugin)} ${v}\``),
        })),
      });
    }
    if (data.tokenUsedBy.length > 0) {
      facts.push({
        folder: "cross-plugin",
        key: "Tokens used by",
        noun: "plugins",
        groups: groupInOrder(
          data.tokenUsedBy,
          (id) => `\`${asPath(id).split("/")[0]}\``,
        ).map(({ label, items }) => ({
          label,
          values: items.map((id) => `\`${asPath(id)}\``),
        })),
      });
    }
    if (data.importedBy.length > 0) {
      // Grouped by the importer's top-level umbrella: 200 importers are not
      // actionable, "apps 88, conversations 40" is.
      facts.push({
        folder: "cross-plugin",
        key: "Imported by",
        noun: "plugins",
        groups: groupInOrder(
          data.importedBy,
          (id) => `\`${asPath(id).split("/")[0]}\``,
        ).map(({ label, items }) => ({
          label,
          values: items.map((id) => `\`${asPath(id)}\``),
        })),
      });
    }
    return facts;
  },
});
