/**
 * Sizes the PREDICTED upfront set of stage 3 of the design "a list entry
 * without its plugin's code" (wiki: Import time and lazy imports): the web
 * plugins a page would send before first paint if a plugin's code loaded only
 * on use and the build predicted the set per starting route — against what
 * the page sends today, by the same byte accounting.
 *
 *   ./equin run plugins/framework/plugins/tooling/plugins/codegen/scripts/measure-predicted-set.ts \
 *     [--main-dist <dir>] [--website-dist <dir>] [--records-root <checkout>] [--top 10] [--list] [--why <plugin id>]…
 *     [--website-used <json>] [--main-used <json>] [--missing]
 *
 * `--*-used` takes a coverage dump (`{ called: [{ src, wire, npm }] }`: the
 * source modules a real load called a function of before first paint, with
 * their wire bytes) and prints how much of it the prediction holds — what it
 * misses would load late, unless it was only called because today's upfront
 * tier loaded it (registration-time calls; see used-at's header). Produce
 * them with `debug/profiling/cold-start/e2e/used-at.ts`:
 *
 *   ./equin run plugins/debug/plugins/profiling/plugins/cold-start/e2e/used-at.ts \
 *     --url http://<website namespace>.localhost:<port> --path / --at fcp --dump "$EQUIN_SCRATCH/used-website.json"
 *   ./equin run plugins/debug/plugins/profiling/plugins/cold-start/e2e/used-at.ts \
 *     --url http://equin.localhost:<port> --path /agents --at content --dump "$EQUIN_SCRATCH/used-agents.json"
 *
 * Inputs (read, never written): the evaluated web barrels of this checkout,
 * or of `--records-root` (the
 * declared slots, their `meta.kind`, every contribution and its plugin) and
 * two deployed dists — main's (`~/.equin/worktrees/<main>/web`, started at
 * `/agents`) and this checkout's `website` composition build
 * (`~/.equin/worktrees/website.<checkout>/web`, started at `/`, the landing
 * page = the website app's index pane). Each dist gives the artifact import
 * graph (`.web-artifacts-edges.json`: every built file's static imports), the
 * import map (vendors), the link record (`modules.json`: module → route
 * chunk, in the shared artifact store) and the served files with their `.br`
 * siblings. The slots come from the evaluated checkout: a dist built from
 * another commit can disagree on a few plugins (printed as "contributors
 * without a web artifact").
 *
 * The evaluation imports every web barrel of the evaluated checkout, so that
 * tree must be consistent (its generated files present). To evaluate main's
 * plugins with main's own code (matching main's dist), run a copy of this
 * script whose `../core` import is spelled
 * `@plugins/framework/plugins/tooling/plugins/codegen/core` from main's
 * checkout: `./equin run` resolves a scratch script's aliases against the
 * checkout it runs in.
 *
 * The website's dist also carries its live demo's page scope (the link's
 * `on-demand` group): those plugins are never a list's contributor here —
 * their entries draw only inside the demo — but a static import still
 * reaches their modules.
 *
 * The prediction (the design's rule, §3):
 * - start: the page entry (web-core), the composition's web registry (the
 *   plugin list — its dynamic imports are NOT followed), every contributor of
 *   the runs-at-start lists `Core.Root` / `Core.Boot`, the app the URL opens
 *   (its `Apps.App` contributor — the list is picked by key) and the app's
 *   index pane (the `Pane.Register` contributor with `appIndex: true` under
 *   the app's umbrella).
 * - two closures, both printed:
 *   ELIDED — a list contributor or picked entry loads its plugin definition
 *   (`__plugin.js`, what the registry's `import()` of a barrel loads today);
 *   a named import of a barrel loads only the module defining each name
 *   (import-then-export hops followed, today's link elision); a namespace or
 *   side-effect import loads the whole barrel; relative imports are followed
 *   file by file.
 *   WHOLE-PLUGIN — decision D10 taken literally: a plugin reached at all is
 *   sent whole (every file its `index.js` reaches), and so is every plugin
 *   any of those files imports (a `core` barrel: its whole core artifact).
 *   Dynamic imports are followed by neither (they load on use today too).
 * - a file of the set that MENTIONS a drawn-whole list (slot kind `render`,
 *   `mount`, `wrap`) adds every contributor of it; repeat to a fixpoint.
 *   Keyed lists (`dispatch`, `ordered-dispatch`, plus `Apps.App` and
 *   `Pane.Register`, which the design names as picked-by-key although their
 *   kind is render / slot) add nothing beyond the start's picks; plain
 *   (`slot`, `ordered`) lists are read as data and add nothing.
 * - the WIDE variant (an upper bound) also adds every contributor of a
 *   mentioned dispatch / plain list whose entries carry code.
 *
 * "Mentions", approximated statically on the BUILT (minified) files: the file
 * imports the slot's export (`E`, or the group `E` holding it as `.K`) from
 * the declaring plugin's web barrel (or relatively, inside it), and uses that
 * binding other than by calling it — `x.K.Render`, `useContributions(x.K)`,
 * `slot={x.K}` count; `x.K({…})` (a contribution) does not. A plugin's
 * definition files (`index.js`, `__plugin.js`) are skipped (they declare and
 * contribute, never draw). A slot no barrel exports (a pane's own slots) is
 * counted as mentioned whenever its declaring plugin is in the set. This
 * over-includes (any non-call use counts as a draw); it can miss a draw that
 * reaches a slot through a value passed around without naming it.
 *
 * Bytes, two accountings for every set (today's and predicted alike):
 * - LINKED: what today's link would send for those modules — each module's
 *   share of its route chunk's brotli size, by raw size (`modules.json`);
 *   modules the link tree-shook or never reached count 0. This keeps today's
 *   elision (a named import loads its defining module, not the whole barrel).
 * - WHOLE: brotli of each artifact's whole file set (D10 taken literally: a
 *   plugin is sent whole).
 * Vendors (npm, through the import map) are the same in both: every vendor
 * file the set imports statically, closed over the vendor files' own static
 * imports, at its `.br` size. Today's SENT set is read from the dist itself:
 * the entry, its modulepreloads, the start app's app-preloads, closed over
 * static imports — the same files a cold load fetches before first paint.
 */
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { basename } from "node:path";
import {
  existsSync,
  readFileSync,
  statSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  findImports,
  type ImportRef,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { loadRepoSnapshot } from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { worktreeDataDir } from "@plugins/infra/plugins/paths/core";
import { webArtifactsDir } from "@plugins/framework/plugins/tooling/plugins/web-artifacts/data-dirs";
import {
  MAIN_WORKTREE_NAME,
  namespaceFor,
} from "@plugins/infra/plugins/namespace/core";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { codegenPassOver, evaluateWebBarrels, recordSlotNaming } from "../core";

// ─── args ────────────────────────────────────────────────────────────────

function argOf(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}
const TOP = Number(argOf("top") ?? 10);
const LIST = process.argv.includes("--list");
/** `--why <plugin id>` (repeatable): print the chain that pulled the plugin in. */
/** `--missing`: list every used module the prediction does not hold. */
const SHOW_MISSING = process.argv.includes("--missing");
const WHY = process.argv.flatMap((a, i) =>
  process.argv[i - 1] === "--why" ? [a] : [],
);

// ─── slots and contributions, from the evaluated records ─────────────────

const root = await getWorktreeRoot();
/** The checkout whose plugins are evaluated: this one, or `--records-root` (e.g. main's, to match main's dist). */
const recordsRoot = argOf("records-root") ?? root;
const pass = codegenPassOver(
  await loadRepoSnapshot(recordsRoot as typeof root),
);
const ev = await evaluateWebBarrels(pass);
const naming = await recordSlotNaming(pass, "registry");

type Contribution = Record<string, unknown> & { _slot?: SlotHandle };

interface SlotInfo {
  id: string;
  kind: string;
  owner: string;
  /** How a reader names it: the barrel export, and the property when grouped. */
  exportName: string | null;
  prop: string | null;
  contributions: { plugin: string; c: Contribution }[];
}

const slots = new Map<string, SlotInfo>();
for (const d of naming.declarations()) {
  const meta = (d.slot as unknown as { meta?: { kind?: string } }).meta;
  slots.set(d.id, {
    id: d.id,
    kind: meta?.kind ?? "?",
    owner: d.pluginId,
    exportName: null,
    prop: null,
    contributions: [],
  });
}

function slotIdOf(v: unknown): string | undefined {
  if (v === null || (typeof v !== "object" && typeof v !== "function"))
    return undefined;
  const l = naming.idOf(v as SlotHandle);
  return l.kind === "named" ? l.id : undefined;
}

for (const ref of ev.refs) {
  const mod = ev.barrels.module(ref.path) as Record<string, unknown>;
  // Where each slot is exported from its declaring barrel.
  for (const [name, value] of Object.entries(mod)) {
    if (name === "default") continue;
    const direct = slotIdOf(value);
    if (direct !== undefined) {
      const s = slots.get(direct);
      if (
        s !== undefined &&
        s.owner === ref.pluginId &&
        s.exportName === null
      ) {
        s.exportName = name;
      }
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    for (const [prop, inner] of Object.entries(value)) {
      const id = slotIdOf(inner);
      if (id === undefined) continue;
      const s = slots.get(id);
      if (
        s !== undefined &&
        s.owner === ref.pluginId &&
        s.exportName === null
      ) {
        s.exportName = name;
        s.prop = prop;
      }
    }
  }
  const def = mod.default as { contributions?: Contribution[] } | undefined;
  for (const c of def?.contributions ?? []) {
    if (c._slot === undefined) continue;
    const id = slotIdOf(c._slot);
    if (id === undefined) continue;
    slots.get(id)?.contributions.push({ plugin: ref.pluginId, c });
  }
}

const CORE_ROOT = "framework.web-sdk.root";
const CORE_BOOT = "framework.web-sdk.boot";
const APPS = "apps-core.app";
const PANES = "primitives.pane.register";
/** Picked by key, whatever their kind says (the design names these two). */
const KEYED_BY_DESIGN = new Set([APPS, PANES]);
const DRAWN_KINDS = new Set(["render", "mount", "wrap"]);
const KEYED_KINDS = new Set(["dispatch", "ordered-dispatch"]);

function carriesCode(s: SlotInfo): boolean {
  return s.contributions.some(({ c }) =>
    Object.entries(c).some(
      ([k, v]) =>
        !k.startsWith("_") &&
        typeof v === "function" &&
        slotIdOf(v) === undefined,
    ),
  );
}

// ─── a dist ──────────────────────────────────────────────────────────────

interface EdgeRow {
  staticImportsByFile: Record<string, string[]>;
  dynamicImports: string[];
}

interface Dist {
  dir: string;
  edges: Record<string, EdgeRow>;
  imports: Record<string, string>;
  /** `<pluginId>|<folder>` → artifact dir. */
  byPlugin: Map<string, string>;
  modules: Record<string, { group: string; chunk: string | null }>;
  entryDir: string;
  registryDir: string;
  /**
   * Plugins the page loads only inside a bundled browser host's scope (the
   * registry's `webScopedEntries`, the link's `on-demand` group: the
   * website's live demo). Their list entries belong to the demo, not to this
   * page, so they are never added as a list's contributor.
   */
  onDemand: Set<string>;
}

/** The content-addressed store every per-plugin artifact lives in (the dist links only route chunks). */
const STORE = webArtifactsDir.file("store");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function artifactParts(dir: string): { plugin: string; folder: string } {
  const parts = dir.split(".");
  return {
    plugin: parts.slice(0, -2).join("."),
    folder: parts[parts.length - 2] ?? "",
  };
}

function openDist(dir: string): Dist {
  const edges = readJson<Record<string, EdgeRow>>(
    `${dir}/.web-artifacts-edges.json`,
  );
  const imports = readJson<{ importMap: { imports: Record<string, string> } }>(
    `${dir}/.web-artifacts.json`,
  ).importMap.imports;
  const link = readJson<{ key: string }>(`${dir}/.web-link.json`);
  const modules = readJson<Dist["modules"]>(
    `${STORE}/link.${link.key.slice(0, 16)}/modules.json`,
  );
  const byPlugin = new Map<string, string>();
  let entryDir = "";
  let registryDir = "";
  for (const a of Object.keys(edges)) {
    const { plugin, folder } = artifactParts(a);
    if (folder === "entry") entryDir = a;
    else if (folder === "registry") registryDir = a;
    else byPlugin.set(`${plugin}|${folder}`, a);
  }
  if (entryDir === "" || registryDir === "")
    throw new Error(`${dir}: no entry or registry artifact in its edges`);
  const onDemand = new Set<string>();
  for (const [m, { group }] of Object.entries(modules))
    if (m.endsWith("/__plugin.js") && group === "on-demand")
      onDemand.add(artifactParts(m.slice(0, m.indexOf("/"))).plugin);
  return {
    dir,
    edges,
    imports,
    byPlugin,
    modules,
    entryDir,
    registryDir,
    onDemand,
  };
}

/** `@plugins/a/plugins/b/web` → the artifact dir, or null when not a plugin barrel. */
function artifactOfSpecifier(d: Dist, spec: string): string | null {
  if (spec === "@composition-web-registry") return d.registryDir;
  if (!spec.startsWith("@plugins/")) return null;
  const parts = spec.slice("@plugins/".length).split("/");
  let folder = parts.pop() ?? "";
  if (folder === "exhibits") folder = "web";
  const plugin = parts.join("/").split("/plugins/").join(".");
  const dir = d.byPlugin.get(`${plugin}|${folder}`);
  if (dir === undefined)
    throw new Error(
      `${d.dir}: ${spec} names no artifact (${plugin}|${folder})`,
    );
  return dir;
}

const fileText = new Map<string, string>();
function readArtifactFile(path: string): string {
  const full = `${STORE}/${path}`;
  let t = fileText.get(full);
  if (t === undefined) {
    t = readFileSync(full, "utf8");
    fileText.set(full, t);
  }
  return t;
}

/** The files `index.js` reaches statically inside one artifact. */
function wholeFiles(d: Dist, dir: string): string[] {
  const row = d.edges[dir];
  if (row === undefined) throw new Error(`no edges for ${dir}`);
  const seen = new Set<string>();
  const todo = ["index.js"];
  while (todo.length > 0) {
    const f = todo.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const s of row.staticImportsByFile[f] ?? []) {
      if (s.startsWith("./") || s.startsWith("../")) {
        todo.push(relativeTo(f, s));
      }
    }
  }
  return [...seen];
}

// ─── bytes ───────────────────────────────────────────────────────────────

function brSizeOfUrl(d: Dist, url: string): number {
  const path = `${d.dir}${url}`;
  if (existsSync(`${path}.br`)) return statSync(`${path}.br`).size;
  return brotliCompressSync(readFileSync(path)).length;
}

const transpiler = new Bun.Transpiler({ loader: "js" });
/** Static imports of a served file, as URLs. */
function staticImportUrls(d: Dist, url: string): string[] {
  const code = readFileSync(`${d.dir}${url}`, "utf8");
  const out: string[] = [];
  for (const imp of transpiler.scanImports(code)) {
    if (imp.kind !== "import-statement") continue;
    const s = imp.path;
    if (s.startsWith("./") || s.startsWith("../") || s.startsWith("/")) {
      out.push(s.startsWith("/") ? s : relativeTo(url, s));
      continue;
    }
    const mapped = d.imports[s];
    if (mapped === undefined)
      throw new Error(`${url}: ${s} not in the import map`);
    out.push(mapped);
  }
  return out;
}

function closeUrls(d: Dist, seeds: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const todo = [...seeds];
  while (todo.length > 0) {
    const u = todo.pop() as string;
    if (seen.has(u)) continue;
    seen.add(u);
    todo.push(...staticImportUrls(d, u));
  }
  return seen;
}

/** Per module (`<dir>/<file>`): its share of its chunk's brotli bytes. */
function linkedModuleBytes(d: Dist): Map<string, number> {
  const rawByChunk = new Map<string, number>();
  const raw = new Map<string, number>();
  for (const [m, { chunk }] of Object.entries(d.modules)) {
    if (chunk === null) continue;
    const size = statSync(`${STORE}/${m}`).size;
    raw.set(m, size);
    rawByChunk.set(chunk, (rawByChunk.get(chunk) ?? 0) + size);
  }
  const brOf = new Map<string, number>();
  const out = new Map<string, number>();
  for (const [m, size] of raw) {
    const chunk = d.modules[m]?.chunk as string;
    let br = brOf.get(chunk);
    if (br === undefined) {
      br = brSizeOfUrl(d, chunk);
      brOf.set(chunk, br);
    }
    out.set(m, (br * size) / (rawByChunk.get(chunk) ?? 1));
  }
  return out;
}

const wholeBrCache = new Map<string, number>();
function wholeBytes(d: Dist, dir: string): number {
  let n = wholeBrCache.get(dir);
  if (n === undefined) {
    const text = wholeFiles(d, dir)
      .map((f) => readArtifactFile(`${dir}/${f}`))
      .join("\n");
    n = brotliCompressSync(Buffer.from(text), {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).length;
    wholeBrCache.set(dir, n);
  }
  return n;
}

// ─── import statements, as the built (preserveModules) files write them ──

interface ImportStmt {
  spec: string;
  /** Imported names; "*" = the whole module (namespace, side effect, or unreadable). */
  names: string[] | "*";
}

const refCache = new Map<string, ImportRef[]>();
/** The static import / export-from statements of one built file (parse-utils' scanner). */
function refsOf(path: string): ImportRef[] {
  let refs = refCache.get(path);
  if (refs === undefined) {
    refs = findImports(readArtifactFile(path)).filter((r) => !r.typeOnly);
    refCache.set(path, refs);
  }
  return refs;
}

/** `{ a as b, c }` / `d, { e }` → the imported (left-hand) names, `default` for a default binding. */
function clauseNames(clause: string): string[] | "*" {
  if (clause.includes("*")) return "*";
  const names: string[] = [];
  const brace = /\{([^}]*)\}/.exec(clause);
  if (
    clause
      .replace(/\{[^}]*\}/, "")
      .replace(/,/g, "")
      .trim() !== ""
  )
    names.push("default");
  if (brace !== null)
    for (const part of (brace[1] as string).split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name !== undefined && name !== "") names.push(name);
    }
  return names;
}

/** `{ a as b }` → [[a, b]]: each binding's imported (or local) and bound (or exported) name. */
function clausePairs(clause: string): [string, string][] {
  const brace = /\{([^}]*)\}/.exec(clause);
  if (brace === null) return [];
  return (brace[1] as string).split(",").flatMap((part) => {
    const [a, b] = part
      .trim()
      .split(/\s+as\s+/)
      .map((x) => x.trim());
    return a === undefined || a === "" ? [] : [[a, b ?? a] as [string, string]];
  });
}

const stmtCache = new Map<string, ImportStmt[]>();
/** Each static import of a file, with the names it binds (edges give the specs). */
function importsOf(d: Dist, dir: string, file: string): ImportStmt[] {
  const key = `${dir}/${file}`;
  const hit = stmtCache.get(key);
  if (hit !== undefined) return hit;
  const refs = refsOf(key);
  const out: ImportStmt[] = [];
  for (const spec of d.edges[dir]?.staticImportsByFile[file] ?? []) {
    const mine = refs.filter((r) => r.specifier === spec && !r.dynamic);
    let names: string[] | "*" = mine.length === 0 ? "*" : [];
    for (const r of mine) {
      const n = r.sideEffect ? "*" : clauseNames(r.clause);
      if (n === "*") {
        names = "*";
        break;
      }
      (names as string[]).push(...n);
    }
    out.push({ spec, names });
  }
  stmtCache.set(key, out);
  return out;
}

/** A relative specifier against its importer (both artifact- or URL-relative paths). */
function relativeTo(importer: string, rel: string): string {
  const base = importer.startsWith("/") ? importer : `/${importer}`;
  const out = new URL(rel, `file://${base}`).pathname;
  return importer.startsWith("/") ? out : out.slice(1);
}

/**
 * The module that DEFINES `name` exported by `dir/file`, following
 * import-then-export and re-export hops (the link's elision). Null when the
 * name is not found statically (the caller takes the whole module).
 */
function definingModule(
  d: Dist,
  dir: string,
  file: string,
  name: string,
  depth = 0,
): { dir: string; file: string } | null {
  if (depth > 20) return null;
  const key = `${dir}/${file}`;
  const text = readArtifactFile(key);
  const refs = refsOf(key);
  const follow = (
    from: string,
    imported: string,
  ): { dir: string; file: string } | null => {
    if (from.startsWith("."))
      return definingModule(
        d,
        dir,
        relativeTo(file, from),
        imported,
        depth + 1,
      );
    const target =
      d.imports[from] !== undefined ? null : artifactOfSpecifier(d, from);
    return target === null
      ? null
      : definingModule(d, target, "index.js", imported, depth + 1);
  };
  // `export { a as name } from "x"`: a re-export hop.
  for (const r of refs) {
    if (r.keyword !== "export") continue;
    for (const [local, exported] of clausePairs(r.clause))
      if (exported === name) return follow(r.specifier, local);
  }
  // `export { local as name }` (no `from`): the local binding.
  let local: string | null = null;
  for (const m of text.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g))
    for (const [l, e] of clausePairs(`{${m[1] as string}}`))
      if (e === name) local = l;
  if (local === null) {
    // `export const X` / `export function X` / `export default`
    if (
      name === "default"
        ? /export\s+default\b/.test(text)
        : new RegExp(
            `export\\s+(?:const|let|var|function|class)\\s+${escapeRe(name)}\\b`,
          ).test(text)
    )
      return { dir, file };
    return null;
  }
  // Is the local an import binding? `import { a as local }` / `import local from`.
  for (const r of refs) {
    if (r.keyword !== "import" || r.sideEffect) continue;
    let imported: string | null = null;
    for (const [a, b] of clausePairs(r.clause)) if (b === local) imported = a;
    if (
      imported === null &&
      r.clause
        .replace(/\{[^}]*\}/, "")
        .replace(/,/g, "")
        .trim() === local
    )
      imported = "default";
    if (imported !== null) return follow(r.specifier, imported);
  }
  return { dir, file };
}

// ─── the prediction ──────────────────────────────────────────────────────

type Mode = "module" | "plugin";

interface Prediction {
  /** Reached files (`dir/file`). */
  files: Set<string>;
  /** Artifact dir → why it first got in. */
  artifacts: Map<string, string>;
  vendorSpecs: Set<string>;
  /** Slot id → where it was first mentioned. */
  mentioned: Map<string, string>;
  missing: Set<string>;
  /** Artifact dir → the file (`dir/file`) whose import or list first pulled it in. */
  parentOf: Map<string, string>;
  appPlugin: string;
  indexPane: string;
}

function escapeRe(s: string): string {
  return s.replace(/[$.*+?^{}()|[\]\\]/g, "\\$&");
}

/** The local names a file binds `exportName` to, importing it from `fromDir`. */
function aliasesOf(
  d: Dist,
  path: string,
  fileDir: string,
  exportName: string,
  fromDir: string,
): string[] {
  const out: string[] = [];
  for (const r of refsOf(path)) {
    if (r.keyword !== "import" || r.sideEffect || r.dynamic) continue;
    const spec = r.specifier;
    let target: string | null;
    if (spec.startsWith("./") || spec.startsWith("../")) target = fileDir;
    else
      target =
        d.imports[spec] !== undefined ? null : artifactOfSpecifier(d, spec);
    if (target !== fromDir) continue;
    for (const [name, alias] of clausePairs(r.clause))
      if (name === exportName) out.push(alias);
  }
  // The declaring module itself: `export { n as E }`.
  if (fileDir === fromDir) {
    const text = readArtifactFile(path);
    for (const m of text.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g))
      for (const [l, e] of clausePairs(`{${m[1] as string}}`))
        if (e === exportName) out.push(l);
  }
  return out;
}

/** `text` with every import / export-from statement blanked (by the scanner's offsets). */
function withoutImportStatements(
  text: string,
  refs: readonly ImportRef[],
): string {
  let out = text;
  for (const r of refs) {
    const start = text.lastIndexOf(r.keyword, r.index);
    const end = r.index + r.specifier.length + 1;
    if (start < 0) continue;
    out = out.slice(0, start) + " ".repeat(end - start) + out.slice(end);
  }
  return out;
}

/** Whether `dir/file` reads the slot other than by calling it (a contribution). */
function mentions(
  d: Dist,
  dir: string,
  file: string,
  slot: SlotInfo,
  ownerWebDir: string,
): boolean {
  if (file === "index.js" || file === "__plugin.js" || slot.exportName === null)
    return false;
  const text = readArtifactFile(`${dir}/${file}`);
  if (!text.includes(slot.exportName)) return false;
  const path = `${dir}/${file}`;
  const aliases = aliasesOf(d, path, dir, slot.exportName, ownerWebDir);
  if (aliases.length === 0) return false;
  const body = withoutImportStatements(text, refsOf(path)).replace(
    /export\s*\{[^}]*\}/g,
    "",
  );
  for (const a of aliases) {
    const re =
      slot.prop === null
        ? new RegExp(`(?<![\\w$.])${escapeRe(a)}(?![\\w$])(?!\\s*[(=:])`)
        : new RegExp(
            `(?<![\\w$.])${escapeRe(a)}\\.${escapeRe(slot.prop)}(?![\\w$])(?!\\s*\\()`,
          );
    if (re.test(body)) return true;
  }
  return false;
}

/**
 * The predicted set from one starting app. `module`: the elided module
 * closure (a list contributor loads its plugin definition `__plugin.js`, a
 * named barrel import loads the defining module — what today's link does).
 * `plugin`: D10 literally — a plugin reached at all is sent whole, and so is
 * every plugin any of its files imports.
 */
function predict(
  d: Dist,
  appBasePath: string,
  wide: boolean,
  mode: Mode,
): Prediction {
  const files = new Set<string>();
  const artifacts = new Map<string, string>();
  const vendorSpecs = new Set<string>();
  const mentioned = new Map<string, string>();
  const missing = new Set<string>();
  const queue: { dir: string; file: string }[] = [];
  const parentOf = new Map<string, string>();
  let current = "";

  const addFile = (dir: string, file: string, why: string): void => {
    const key = `${dir}/${file}`;
    if (files.has(key)) return;
    if (!artifacts.has(dir)) {
      artifacts.set(dir, why);
      parentOf.set(dir, current);
    }
    if (mode === "plugin") {
      const whole = wholeFiles(d, dir);
      if (!whole.includes(file)) whole.push(file);
      for (const f of whole) {
        if (files.has(`${dir}/${f}`)) continue;
        files.add(`${dir}/${f}`);
        queue.push({ dir, file: f });
      }
      return;
    }
    files.add(key);
    queue.push({ dir, file });
  };
  const webDirOf = (plugin: string): string | undefined =>
    d.byPlugin.get(`${plugin}|web`);
  const addPlugin = (plugin: string, why: string): void => {
    const dir = webDirOf(plugin);
    if (d.onDemand.has(plugin)) return;
    if (dir === undefined) missing.add(plugin);
    else addFile(dir, "__plugin.js", why);
  };
  const addList = (slot: SlotInfo, why: string): void => {
    for (const { plugin } of slot.contributions) addPlugin(plugin, why);
  };

  addFile(d.entryDir, "index.js", "start: page entry");
  addFile(
    d.registryDir,
    "index.js",
    "start: plugin list (its dynamic imports not followed)",
  );
  for (const id of [CORE_ROOT, CORE_BOOT]) {
    const s = slots.get(id);
    if (s === undefined) throw new Error(`no slot ${id}`);
    mentioned.set(id, "start");
    addList(s, `runs at start: ${id}`);
  }
  const app = (slots.get(APPS)?.contributions ?? []).find(
    ({ c }) =>
      (c.app as { basePath?: string } | undefined)?.basePath === appBasePath,
  );
  if (app === undefined) throw new Error(`no app at ${appBasePath}`);
  addPlugin(app.plugin, `start: the app at ${appBasePath} (${APPS}, keyed)`);
  const umbrella = `${app.plugin.split(".").slice(0, -1).join(".")}.`;
  const pane = (slots.get(PANES)?.contributions ?? []).find(
    ({ plugin, c }) =>
      plugin.startsWith(umbrella) &&
      (c.pane as { appIndex?: boolean } | undefined)?.appIndex === true &&
      webDirOf(plugin) !== undefined,
  );
  if (pane === undefined) throw new Error(`no index pane under ${umbrella}`);
  addPlugin(pane.plugin, `start: the app's index pane (${PANES}, keyed)`);

  const candidates = [...slots.values()].filter((s) => {
    if (
      s.contributions.length === 0 ||
      mentioned.has(s.id) ||
      KEYED_BY_DESIGN.has(s.id)
    )
      return false;
    if (DRAWN_KINDS.has(s.kind)) return true;
    return wide && carriesCode(s);
  });
  const byOwner = new Map<string, SlotInfo[]>();
  for (const s of candidates) {
    const w = webDirOf(s.owner);
    if (w === undefined) continue;
    const list = byOwner.get(w) ?? [];
    list.push(s);
    byOwner.set(w, list);
  }

  while (queue.length > 0) {
    const { dir, file } = queue.shift() as { dir: string; file: string };
    current = `${dir}/${file}`;
    const { plugin } = artifactParts(dir);
    for (const imp of importsOf(d, dir, file)) {
      if (imp.spec.startsWith("./") || imp.spec.startsWith("../")) {
        addFile(dir, relativeTo(file, imp.spec), artifacts.get(dir) as string);
        continue;
      }
      if (d.imports[imp.spec] !== undefined) {
        vendorSpecs.add(imp.spec);
        continue;
      }
      const target = artifactOfSpecifier(d, imp.spec);
      if (target === null) continue;
      const why = `imported by ${plugin}`;
      if (imp.names === "*" || mode === "plugin") {
        addFile(target, "index.js", why);
        continue;
      }
      for (const name of imp.names) {
        const def = definingModule(d, target, "index.js", name);
        if (def === null) addFile(target, "index.js", why);
        else addFile(def.dir, def.file, why);
      }
    }
    // Lists this file mentions: every slot whose owner this file can name.
    const imported = new Set(
      importsOf(d, dir, file)
        .map((i) =>
          i.spec.startsWith(".")
            ? dir
            : d.imports[i.spec] !== undefined
              ? null
              : artifactOfSpecifier(d, i.spec),
        )
        .filter((x): x is string => x !== null),
    );
    imported.add(dir);
    for (const owner of imported) {
      for (const s of byOwner.get(owner) ?? []) {
        if (mentioned.has(s.id)) continue;
        const hit =
          s.exportName === null
            ? dir === owner && file !== "index.js"
            : mentions(d, dir, file, s, owner);
        if (!hit) continue;
        const where = `${plugin}/${file}`;
        mentioned.set(s.id, where);
        const kindWord = DRAWN_KINDS.has(s.kind)
          ? "drawn whole"
          : `${KEYED_KINDS.has(s.kind) ? "keyed" : "data"} list (${s.kind}), wide`;
        addList(s, `${kindWord}: ${s.id} (mentioned in ${where})`);
      }
    }
  }
  return {
    files,
    artifacts,
    vendorSpecs,
    mentioned,
    missing,
    parentOf,
    appPlugin: app.plugin,
    indexPane: pane.plugin,
  };
}

// ─── report ──────────────────────────────────────────────────────────────

const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;

interface Totals {
  plugins: number;
  artifacts: number;
  modules: number;
  modulesLinked: number;
  ourLinked: number;
  /** D10 accounting: brotli of each reached artifact's whole file set. */
  ourWhole: number;
  vendorFiles: number;
  vendorBytes: number;
  perPlugin: Map<string, { linked: number; whole: number }>;
}

function totalsOf(
  d: Dist,
  files: Iterable<string>,
  vendorUrls: ReadonlySet<string>,
  linked: ReadonlyMap<string, number>,
): Totals {
  const perPlugin = new Map<string, { linked: number; whole: number }>();
  const dirs = new Set<string>();
  const webPlugins = new Set<string>();
  let modules = 0;
  let modulesLinked = 0;
  let ourLinked = 0;
  for (const key of files) {
    modules++;
    const dir = key.slice(0, key.indexOf("/"));
    dirs.add(dir);
    const { plugin, folder } = artifactParts(dir);
    if (folder === "web") webPlugins.add(plugin);
    const b = linked.get(key);
    const row = perPlugin.get(plugin) ?? { linked: 0, whole: 0 };
    if (b !== undefined) {
      modulesLinked++;
      ourLinked += b;
      row.linked += b;
    }
    perPlugin.set(plugin, row);
  }
  let ourWhole = 0;
  for (const dir of dirs) {
    const w = wholeBytes(d, dir);
    ourWhole += w;
    const row = perPlugin.get(artifactParts(dir).plugin);
    if (row !== undefined) row.whole += w;
  }
  let vendorBytes = 0;
  for (const u of vendorUrls) vendorBytes += brSizeOfUrl(d, u);
  return {
    plugins: webPlugins.size,
    artifacts: dirs.size,
    modules,
    modulesLinked,
    ourLinked,
    ourWhole,
    vendorFiles: vendorUrls.size,
    vendorBytes,
    perPlugin,
  };
}

function line(label: string, t: Totals): string {
  return (
    `${label.padEnd(30)} ${String(t.plugins).padStart(4)} web plugins, ${String(t.artifacts).padStart(4)} artifacts, ${String(t.modules).padStart(5)} modules | ` +
    `LINKED ${kb(t.ourLinked + t.vendorBytes).padStart(8)} (ours ${kb(t.ourLinked)} in ${t.modulesLinked} linked modules) | ` +
    `WHOLE ${kb(t.ourWhole + t.vendorBytes).padStart(8)} (ours ${kb(t.ourWhole)}) | npm ${kb(t.vendorBytes)} in ${t.vendorFiles} files`
  );
}

interface UsedDump {
  called: { src: string; wire: number; npm: boolean }[];
}

const FOLDERS = new Set(["web", "core", "shared", "exhibits"]);
/** A source-map source (`…/plugins/a/plugins/b/web/x.tsx`) → its built file key (`<dir>/web/x.js`). */
function storeKeyOfSource(d: Dist, src: string): string | null {
  const at = src.indexOf("plugins/");
  if (at < 0) return null;
  const segs = src.slice(at).split("/");
  const id: string[] = [];
  let i = 1;
  while (i < segs.length) {
    id.push(segs[i] as string);
    i++;
    if (segs[i] === "plugins") {
      i++;
      continue;
    }
    break;
  }
  const folder = segs[i];
  if (folder === undefined || !FOLDERS.has(folder)) return null;
  let rest = segs
    .slice(i)
    .join("/")
    .replace(/\.(tsx?|jsx?|mjs)$/, ".js");
  // A barrel's definition and the barrel itself sit at the artifact's root.
  if (rest === `${folder}/__plugin.js` || rest === `${folder}/index.js`)
    rest = rest.slice(folder.length + 1);
  const plugin = id.join(".");
  if (plugin === "framework.web-core")
    return `${d.entryDir}/${segs
      .slice(i + 1)
      .join("/")
      .replace(/\.(tsx?|jsx?)$/, ".js")}`;
  const dir = d.byPlugin.get(`${plugin}|${folder === "core" ? "core" : "web"}`);
  return dir === undefined ? null : `${dir}/${rest}`;
}

/** How much of what the page really used before first paint the prediction holds. */
function compareUsed(
  d: Dist,
  used: UsedDump,
  predicted: ReadonlySet<string>,
): void {
  const ours = used.called.filter((u) => !u.npm);
  let inN = 0;
  let inWire = 0;
  let unmapped = 0;
  const missingByPlugin = new Map<string, { n: number; wire: number }>();
  for (const u of ours) {
    const key = storeKeyOfSource(d, u.src);
    if (key === null) {
      unmapped++;
      continue;
    }
    if (predicted.has(key)) {
      inN++;
      inWire += u.wire;
      continue;
    }
    if (SHOW_MISSING)
      console.log(
        `     missing module ${u.src} → ${key} ${d.modules[key] === undefined ? "(not a linked module)" : d.modules[key]?.group}`,
      );
    const plugin = artifactParts(key.slice(0, key.indexOf("/"))).plugin;
    const row = missingByPlugin.get(plugin) ?? { n: 0, wire: 0 };
    row.n++;
    row.wire += u.wire;
    missingByPlugin.set(plugin, row);
  }
  const outWire = [...missingByPlugin.values()].reduce((a, r) => a + r.wire, 0);
  const outN = [...missingByPlugin.values()].reduce((a, r) => a + r.n, 0);
  console.log(
    `   USED by first paint (ours, called): ${ours.length} modules; in the prediction ${inN} (~${kb(inWire)}), ` +
      `NOT in it ${outN} (~${kb(outWire)}, would load late), ${unmapped} unmapped (generated / outside plugins)`,
  );
  for (const [plugin, r] of [...missingByPlugin]
    .sort((a, b) => b[1].wire - a[1].wire)
    .slice(0, 8))
    console.log(
      `     missing ${kb(r.wire).padStart(6)} ${String(r.n).padStart(4)} modules  ${plugin}`,
    );
}

function measureTarget(
  label: string,
  d: Dist,
  appBasePath: string,
  appRoot: string,
  used: UsedDump | null,
): void {
  console.log(`\n══ ${label} — ${d.dir}`);
  const linked = linkedModuleBytes(d);

  // Today: what the dist sends before first paint.
  const html = readFileSync(`${d.dir}/index.html`, "utf8");
  const entry = /<script type="module" src="([^"]+)"/.exec(html)?.[1];
  if (entry === undefined) throw new Error("no entry script in index.html");
  const preloads = [
    ...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g),
  ].map((m) => m[1] as string);
  const appPreloads =
    readJson<{ apps: Record<string, string[]> }>(`${d.dir}/.app-preloads.json`)
      .apps[appRoot] ?? [];
  const sentUrls = closeUrls(d, [entry, ...preloads, ...appPreloads]);
  const sentChunks = new Set(
    [...sentUrls].filter((u) => u.startsWith("/artifacts/chunk.")),
  );
  const sentVendors = new Set([...sentUrls].filter((u) => !sentChunks.has(u)));
  let sentChunkBytes = 0;
  for (const u of sentChunks) sentChunkBytes += brSizeOfUrl(d, u);
  let sentVendorBytes = 0;
  for (const u of sentVendors) sentVendorBytes += brSizeOfUrl(d, u);
  const sentFiles = Object.entries(d.modules)
    .filter(([, m]) => m.chunk !== null && sentChunks.has(m.chunk))
    .map(([k]) => k);
  console.log(
    `TODAY SENT (the served files)  ${sentUrls.size} scripts, ${kb(sentChunkBytes + sentVendorBytes)} br ` +
      `(our route chunks ${kb(sentChunkBytes)} in ${sentChunks.size} files, npm ${kb(sentVendorBytes)} in ${sentVendors.size}); ` +
      (appPreloads.length === 0
        ? `no app-preloads for ${appRoot}`
        : `incl. the ${appPreloads.length} app-preload seeds of ${appRoot}`),
  );
  const today = totalsOf(d, sentFiles, sentVendors, linked);
  console.log(line("today, same accounting", today));

  for (const mode of ["module", "plugin"] as const) {
    for (const wide of [false, true]) {
      const p = predict(d, appBasePath, wide, mode);
      const vendorUrls = closeUrls(
        d,
        [...p.vendorSpecs].map((s) => d.imports[s] as string),
      );
      const t = totalsOf(d, p.files, vendorUrls, linked);
      const label = `PREDICTED ${mode === "module" ? "elided" : "whole-plugin"} (${wide ? "wide" : "rule"})`;
      console.log(line(label, t));
      if (used !== null && mode === "module") compareUsed(d, used, p.files);
      const predictedDirs = new Set(
        [...p.files].map((k) => k.slice(0, k.indexOf("/"))),
      );
      const todayDirs = new Set(
        sentFiles.map((k) => k.slice(0, k.indexOf("/"))),
      );
      console.log(
        `   app ${p.appPlugin}, index pane ${p.indexPane}; lists that pulled plugins in: ${p.mentioned.size}; ` +
          `vs today: ${[...predictedDirs].filter((x) => !todayDirs.has(x)).length} artifacts predicted but not sent today, ` +
          `${[...todayDirs].filter((x) => !predictedDirs.has(x)).length} sent today but not predicted` +
          (p.missing.size > 0
            ? `; ${p.missing.size} contributors have no web artifact in this dist (other composition / other commit)`
            : ""),
      );
      if (wide) continue;
      const why = new Map<string, string>();
      for (const [dir, w] of p.artifacts) {
        const { plugin, folder } = artifactParts(dir);
        if (!why.has(plugin) || folder === "web") why.set(plugin, w);
      }
      const rows = [...t.perPlugin].sort((a, b) => b[1].linked - a[1].linked);
      console.log(
        `   top ${TOP} plugins by LINKED bytes [WHOLE], and why they got in:`,
      );
      const chainOf = (plugin: string): string => {
        const dir =
          d.byPlugin.get(`${plugin}|web`) ??
          d.byPlugin.get(`${plugin}|core`) ??
          (plugin === artifactParts(d.registryDir).plugin ? d.registryDir : "");
        const hops: string[] = [];
        let at = p.parentOf.get(dir) ?? "";
        for (let i = 0; at !== "" && i < 40; i++) {
          const parentDir = at.slice(0, at.indexOf("/"));
          hops.push(
            `${artifactParts(parentDir).plugin}/${at.slice(at.indexOf("/") + 1)}`,
          );
          at = p.parentOf.get(parentDir) ?? "";
        }
        return hops.join(" ← ");
      };
      for (const [plugin, b] of rows.slice(0, TOP)) {
        console.log(
          `     ${kb(b.linked).padStart(7)} [${kb(b.whole).padStart(7)}]  ${plugin} — ${why.get(plugin)}`,
        );
        if (mode === "module")
          console.log(`              chain: ${chainOf(plugin)}`);
      }
      for (const plugin of WHY)
        console.log(
          `   why ${plugin}: ${why.get(plugin) ?? "not in the set"}; chain: ${chainOf(plugin)}`,
        );
      const byReason = new Map<string, { n: number; bytes: number }>();
      const reasonOfDir = new Map<string, string>();
      for (const [dir, w] of p.artifacts)
        reasonOfDir.set(
          dir,
          w
            .replace(/ \(mentioned in .*\)$/, "")
            .replace(
              /^imported by .*/,
              "imported (static import from another member)",
            ),
        );
      for (const key of p.files) {
        const r = reasonOfDir.get(key.slice(0, key.indexOf("/"))) as string;
        const row = byReason.get(r) ?? { n: 0, bytes: 0 };
        row.n++;
        row.bytes += linked.get(key) ?? 0;
        byReason.set(r, row);
      }
      console.log(
        "   LINKED bytes by the reason each artifact FIRST got in (modules):",
      );
      for (const [k, r] of [...byReason]
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .slice(0, 20))
        console.log(
          `     ${kb(r.bytes).padStart(7)}  ${String(r.n).padStart(5)}  ${k}`,
        );
      if (LIST) {
        for (const [id, where] of p.mentioned)
          console.log(`   list ${id} ← ${where}`);
        for (const [dir, w] of p.artifacts) console.log(`   + ${dir} — ${w}`);
      }
    }
  }
}

const checkout = basename(root);
const mainDist =
  argOf("main-dist") ?? `${worktreeDataDir(MAIN_WORKTREE_NAME)}/web`;
const websiteDist =
  argOf("website-dist") ??
  `${worktreeDataDir(namespaceFor("website", { kind: "worktree", name: checkout }))}/web`;

const withContributions = [...slots.values()].filter(
  (s) => s.contributions.length > 0,
);
console.log(
  `slots with contributions: ${withContributions.length}; drawn kinds (render/mount/wrap) not exported by their barrel ` +
    `(counted as mentioned once any of their owner's files is in): ` +
    withContributions.filter(
      (s) =>
        s.exportName === null &&
        DRAWN_KINDS.has(s.kind) &&
        !KEYED_BY_DESIGN.has(s.id),
    ).length,
);
const usedOf = (name: string): UsedDump | null => {
  const path = argOf(name);
  return path === undefined ? null : readJson<UsedDump>(path);
};
measureTarget(
  "website /  (the landing page)",
  openDist(websiteDist),
  "/about",
  "apps/plugins/website/",
  usedOf("website-used"),
);
measureTarget(
  "main /agents",
  openDist(mainDist),
  "/agents",
  "apps/plugins/agent-manager/",
  usedOf("main-used"),
);
