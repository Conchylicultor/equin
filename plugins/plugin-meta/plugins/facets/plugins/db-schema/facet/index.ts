import { basename, relative } from "path";
import {
  createFacet,
  getFacet,
  type DocFact,
} from "@plugins/plugin-meta/plugins/facets/core";
import {
  type PluginTree,
  type PluginNode,
  resolvePluginSpecifier,
} from "@plugins/plugin-meta/plugins/plugin-tree/core";
import {
  asPath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  readIfExists,
  stripTypes,
  findMarkerCalls,
  findImports,
  maskSource,
  markerCallSpans,
  walkFiles,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { type DbSchemaFacetData, dbSchemaFacetDef } from "../core";
import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// ── Helpers ────────────────────────────────────────────────────────────

interface ImportBinding {
  local: string;
  original: string;
  module: string;
}

function parseImports(src: string): Map<string, ImportBinding> {
  const map = new Map<string, ImportBinding>();
  // `findImports` masks strings/comments/regex fully and reads each specifier
  // back by offset, so an import written inside a string can never register a
  // phantom binding. The old namedRe/defRe were `import`-only and never matched
  // a whole-statement `import type …` or a namespace `import * as X`, so those
  // are filtered out to keep behavior identical.
  for (const imp of findImports(src)) {
    if (imp.keyword !== "import") continue;
    if (imp.sideEffect) continue;
    if (imp.typeOnly) continue;
    const clause = imp.clause;
    if (/^\s*\*\s/.test(clause)) continue; // namespace `import * as X`
    const mod = imp.specifier;
    const braceIdx = clause.indexOf("{");
    if (braceIdx < 0) {
      // Default-only `import Foo from` — the whole clause is the local id (defRe).
      const head = clause.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(head)) {
        map.set(head, { local: head, original: "default", module: mod });
      }
      continue;
    }
    // Default alongside named (`import Foo, { … } from`) — the namedRe m[1] branch.
    const defMatch = clause.slice(0, braceIdx).match(/([A-Za-z_$][\w$]*)\s*,/);
    if (defMatch) {
      const defLocal = defMatch[1]!;
      map.set(defLocal, { local: defLocal, original: "default", module: mod });
    }
    const closeIdx = clause.indexOf("}", braceIdx);
    const names = clause.slice(
      braceIdx + 1,
      closeIdx < 0 ? clause.length : closeIdx,
    );
    for (const raw of names.split(",")) {
      let s = raw.trim();
      if (!s) continue;
      s = s.replace(/^type\s+/, "");
      const asMatch = s.match(/^(\w+)\s+as\s+(\w+)$/);
      if (asMatch)
        map.set(asMatch[2]!, {
          local: asMatch[2]!,
          original: asMatch[1]!,
          module: mod,
        });
      else if (/^\w+$/.test(s))
        map.set(s, { local: s, original: s, module: mod });
    }
  }
  return map;
}

interface RawExtRef {
  parentVarName: string;
  parentModule: string;
  extName: string;
}

// `defineExtension(ParentVar, "name")` — the first positional arg is the parent
// table variable, the second a string literal name.
const EXTENSION_ARGS_RE = /^\s*([A-Za-z_$][\w$]*)\s*,\s*"([^"]+)"/;

function parseEntityExtensionCalls(sources: readonly string[]): RawExtRef[] {
  const out: RawExtRef[] = [];
  for (const raw of sources) {
    if (!raw.includes("defineExtension")) continue;
    const src = stripTypes(raw);
    const imports = parseImports(src);
    for (const call of findMarkerCalls(src, "defineExtension")) {
      const args = EXTENSION_ARGS_RE.exec(call.argsText);
      if (!args) continue;
      const imp = imports.get(args[1]!);
      if (!imp) continue;
      out.push({
        parentVarName: imp.original,
        parentModule: imp.module,
        extName: args[2]!,
      });
    }
  }
  return out;
}

// Recovers `varName → physical table name` for one schema source file. Two
// declaration forms produce a physical table, and consumers import the bound
// variable to extend it:
//
//   1. Raw drizzle:   `const _foo = pgTable("foo", …)`            → `_foo → foo`
//   2. defineEntity:  `const fooEntity = defineEntity(fooEntityRef, …)`  (infra/entities)
//                     `export const _foo = fooEntity.table`        → `_foo → foo`
//
// For form (2) the `pgTable(...)` call is hidden inside `defineEntity`, so the
// physical table surfaces as `<entity>.table`; its name is the ref's, read from
// the `const fooEntityRef = entityRef("foo", …)` declaration (`refNames`). We map the `.table` alias (the
// name consumers actually import) to the entity's table name, and drop the
// intermediate entity binding so a table is never reported twice.
export function parseTableNames(
  src: string,
  out: Map<string, string>,
  refNames: ReadonlyMap<string, string> = new Map(),
): void {
  resolveTableNames(parseTableDecls(src), refNames, out);
}

/**
 * The table declarations of one schema file, before the refs are known — what
 * the facet's record stores, so `relate` can name an entity built from ANOTHER
 * plugin's ref without reading the file again.
 */
export function parseTableDecls(src: string): TableDecls {
  // FULL-mask so a `pgTable("x")` / `defineEntity(ref)` / `.table` written in a
  // comment, string, or template literal (a fixture, docs snippet, codegen
  // template) can't register a phantom table. Genuine calls are located over the
  // mask via `markerCallSpans`; the binding var name and the string name are
  // read back from the ORIGINAL by offset (the mask preserves offsets 1:1) — the
  // sanctioned marker-value contract, not a hand-rolled `const X = pgTable("…")`
  // regex over raw source.
  const masked = maskSource(src);
  const declBefore = (upTo: number): string | undefined =>
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(
      masked.slice(0, upTo),
    )?.[1];
  const firstStringArg = (open: number, close: number): string | undefined =>
    /^\s*["']([^"']+)["']/.exec(src.slice(open + 1, close))?.[1];

  const decls: TableDecls = { tables: [], entities: [], aliases: [] };
  // Form (1): direct `const <var> = pgTable("name", …)` bindings.
  for (const span of markerCallSpans(masked, "pgTable")) {
    const varName = declBefore(span.identifier);
    const name = firstStringArg(span.open, span.close);
    if (varName && name) decls.tables.push([varName, name]);
  }
  // Form (2a): `const <entity> = defineEntity(<ref>, …)` bindings, named later
  // by the ref's own `entityRef("name", …)`.
  for (const span of markerCallSpans(masked, "defineEntity")) {
    const varName = declBefore(span.identifier);
    const ref = /^\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(
      masked.slice(span.open + 1, span.close + 1),
    )?.[1];
    if (varName && ref) decls.entities.push([varName, ref]);
  }
  // Form (2b): `const <alias> = <entity>.table` re-exports — the alias is the
  // importable handle; the entity var is intermediate. Matched over the mask
  // (identifiers aren't blanked, so a `.table` in a string can't register).
  const aliasRe =
    /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.table\b/g;
  let m: RegExpExecArray | null;
  while ((m = aliasRe.exec(masked))) decls.aliases.push([m[1]!, m[2]!]);
  return decls;
}

/** One schema file's declarations, refs unresolved (see {@link parseTableDecls}). */
export interface TableDecls {
  /** `[var, table name]` of each direct `pgTable("name")` binding. */
  tables: [string, string][];
  /** `[entity var, ref var]` of each `defineEntity(<ref>, …)` binding. */
  entities: [string, string][];
  /** `[alias, entity var]` of each `const <alias> = <entity>.table`. */
  aliases: [string, string][];
}

/** `varName → physical table name` of `decls`, now that every ref is known. */
function resolveTableNames(
  decls: TableDecls,
  refNames: ReadonlyMap<string, string>,
  out: Map<string, string>,
): void {
  for (const [v, name] of decls.tables) out.set(v, name);
  const entityVarToName = new Map<string, string>();
  for (const [v, ref] of decls.entities) {
    const name = refNames.get(ref);
    if (name !== undefined) entityVarToName.set(v, name);
  }
  const aliasSources = new Set<string>();
  for (const [alias, entity] of decls.aliases) {
    const name = entityVarToName.get(entity);
    if (name === undefined) continue;
    out.set(alias, name);
    aliasSources.add(entity);
  }
  // Inline `const <alias> = defineEntity(<ref>, …).table` (no separate
  // statement): the binding var is itself the usable handle. Keep every entity
  // var not already consumed as a `.table` alias source.
  for (const [v, name] of entityVarToName) {
    if (!aliasSources.has(v)) out.set(v, name);
  }
}

// `const <ref> = entityRef("name", …)` declarations in one source file:
// `ref → table name`. A ref is declared in a plugin's browser-safe `core/` and
// named by the `defineEntity(<ref>, …)` of its server `tables.ts`.
export function parseEntityRefNames(
  src: string,
  out: Map<string, string>,
): void {
  const masked = maskSource(src);
  for (const span of markerCallSpans(masked, "entityRef")) {
    const varName = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(
      masked.slice(0, span.identifier),
    )?.[1];
    const name = /^\s*["']([^"']+)["']/.exec(
      src.slice(span.open + 1, span.close),
    )?.[1];
    if (varName && name) out.set(varName, name);
  }
}

// Every ref a plugin declares anywhere in its own tree. A plugin whose tables
// are built from ANOTHER plugin's ref (imported through its barrel) resolves it
// in `relate`, over every plugin's refs — never through state kept between two
// plugins' extractions, which a plugin record (one extraction, cached on its own
// files) cannot see.
function collectRefNames(pluginDir: AppPath): [string, string][] {
  const files: AppPath[] = [];
  walkFiles(pluginDir, files);
  const local = new Map<string, string>();
  for (const f of files) {
    const raw = readIfExists(f);
    if (!raw || !raw.includes("entityRef(")) continue;
    parseEntityRefNames(stripTypes(raw), local);
  }
  return [...local];
}

// Enumerates through the shared `walkFiles`, which owns the rule for what is
// source and what is not (test code, sub-plugin trees, `node_modules`). A
// private walker here once listed a `server/testing/` harness as DB schema,
// because its file name contained "schema".
function findDbFiles(pluginDir: AppPath): AppPath[] {
  const files: AppPath[] = [];
  walkFiles(joinAppPath(pluginDir, "server"), files);
  return files
    .filter((full) => {
      const name = basename(full);
      if (!name.endsWith(".ts") || name === "index.ts") return false;
      if (/schema|tables?/.test(name.replace(/\.ts$/, ""))) return true;
      // Mask comments + string interiors so a commented or stringified
      // `pgTable(` / `pgView(` doesn't misclassify a non-schema file.
      const raw = readIfExists(full);
      const src = raw === null ? null : maskSource(raw, { strings: true });
      return !!src && (src.includes("pgTable(") || src.includes("pgView("));
    })
    .sort();
}

// ── Facet ──────────────────────────────────────────────────────────────

export default createFacet<DbSchemaFacetData>({
  def: dbSchemaFacetDef,

  extract(ctx) {
    const dbFiles = findDbFiles(ctx.dir);
    const sources = dbFiles.map((f) => readIfExists(f) ?? "");
    const refNames = collectRefNames(ctx.dir);
    const decls = sources.map((src) => parseTableDecls(stripTypes(src)));
    const local = new Map(refNames);
    const tableMap = new Map<string, string>();
    for (const d of decls) resolveTableNames(d, local, tableMap);
    return {
      // Repo-relative: a record is shared by every worktree, so it holds no
      // path of this checkout.
      dbFiles: dbFiles.map((f) => `${ctx.relDir}/${relative(ctx.dir, f)}`),
      tables: [...tableMap.entries()].map(([varName, name]) => ({
        name,
        varName,
      })),
      entityExtensions: [],
      extendedBy: [],
      raw: {
        refNames,
        decls,
        extensions: parseEntityExtensionCalls(sources),
      },
    };
  },

  relate(rawCtx) {
    const { tree } = rawCtx as { tree: PluginTree };
    const byId = new Map<PluginId, PluginNode>();
    for (const node of tree.byDir.values()) byId.set(node.id, node);

    // A table built from another plugin's ref could not be named in `extract`
    // (it saw its own plugin only): every plugin's refs are known now, so
    // resolve each plugin's declarations against all of them.
    const allRefNames = new Map<string, string>();
    for (const node of tree.byDir.values()) {
      for (const [k, v] of getFacet(node, dbSchemaFacetDef)?.raw?.refNames ??
        [])
        allRefNames.set(k, v);
    }
    for (const node of tree.byDir.values()) {
      const d = getFacet(node, dbSchemaFacetDef);
      if (!d?.raw) continue;
      const tableMap = new Map<string, string>();
      for (const decls of d.raw.decls)
        resolveTableNames(decls, allRefNames, tableMap);
      d.tables = [...tableMap.entries()].map(([varName, name]) => ({
        name,
        varName,
      }));
    }

    // Build node.id → varName→tableName map from Phase 1 extract data
    const pluginVarToTable = new Map<PluginId, Map<string, string>>();
    for (const node of tree.byDir.values()) {
      const d = getFacet(node, dbSchemaFacetDef);
      if (!d) continue;
      const m = new Map<string, string>();
      for (const t of d.tables) m.set(t.varName, t.name);
      pluginVarToTable.set(node.id, m);
    }

    for (const node of tree.byDir.values()) {
      const data = getFacet(node, dbSchemaFacetDef);
      if (!data) continue;
      for (const ref of data.raw?.extensions ?? []) {
        // A defineExtension parent is always a cross-plugin barrel import.
        if (!ref.parentModule.startsWith("@plugins/")) continue;
        const r = resolvePluginSpecifier(tree, ref.parentModule);
        // Same rationale as the cross-refs facet: an unresolved parent is a
        // genuine bug already caught by tsc + the boundary checker at build
        // time, or a transient artifact of building this tree at runtime over a
        // live, mid-mutation working dir (e.g. the `main` checkout half-written
        // during a `./equin push` merge). Skip rather than crash the tree
        // build for an unrelated baseline tree.
        if (!r) continue;
        const parentPlugin = r.node.id;
        const parentTableName =
          (pluginVarToTable.get(parentPlugin) ?? new Map()).get(
            ref.parentVarName,
          ) ?? "";
        const tableName = parentTableName
          ? `${parentTableName}_ext_${ref.extName}`
          : `${r.node.name}_ext_${ref.extName}`;
        if (!data.entityExtensions.some((e) => e.tableName === tableName)) {
          data.entityExtensions.push({
            parentPlugin,
            extName: ref.extName,
            tableName,
          });
        }
        const parentNode = byId.get(parentPlugin);
        if (!parentNode) continue;
        const parentData = getFacet(parentNode, dbSchemaFacetDef);
        if (
          parentData &&
          !parentData.extendedBy.some((e) => e.tableName === tableName)
        ) {
          parentData.extendedBy.push({
            childPlugin: node.id,
            extName: ref.extName,
            tableName,
          });
        }
      }
    }

    for (const node of tree.byDir.values()) {
      const d = getFacet(node, dbSchemaFacetDef);
      if (!d) continue;
      d.entityExtensions.sort((a, b) => a.tableName.localeCompare(b.tableName));
      d.extendedBy.sort((a, b) => a.tableName.localeCompare(b.tableName));
      // Relate's own inputs: resolved now, so nothing downstream reads them.
      d.raw = undefined;
    }
  },

  renderDoc(data) {
    const facts: DocFact[] = [];
    if (data.dbFiles.length > 0) {
      facts.push({
        folder: "server",
        key: "DB schema",
        values: data.dbFiles.map((f) => `\`${f}\``),
      });
    }
    if (data.entityExtensions.length > 0) {
      facts.push({
        folder: "server",
        key: "Entity extension of",
        values: data.entityExtensions.map(
          (ext) =>
            `\`${asPath(ext.parentPlugin)}\` (table \`${ext.tableName}\`)`,
        ),
      });
    }
    if (data.extendedBy.length > 0) {
      facts.push({
        folder: "cross-plugin",
        key: "Extended by",
        values: data.extendedBy.map(
          (e) => `\`${asPath(e.childPlugin)}\` (table \`${e.tableName}\`)`,
        ),
      });
    }
    return facts;
  },
});
