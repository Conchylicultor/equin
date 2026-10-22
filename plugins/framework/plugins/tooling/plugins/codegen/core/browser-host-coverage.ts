// A browser host's coverage guard: everything the host's scoped page uses has
// an answer. A page scoped to a host (`<PluginScope>` over `browserHost`) runs
// exactly the composition's web plugins, and everything they ask the server
// goes to the host's worker — which boots only the inferred graph's portable
// `server/` barrels (`browser-host-gen.ts`). So for every declaration the
// scope's code references:
//
// - a LIVE READ (a `liveValue` / `liveCollection` it imports) is served by a
//   graph member's `server/` — or declares `needsMachine`, and the page renders
//   it "not available". A central read (`origin: "central"`) must declare
//   `needsMachine` for now: no browser host runs central.
// - an ENDPOINT (a `defineEndpoint` it imports, or a raw `/api/<prefix>`
//   literal) is served by a graph member's `server/` route — or declares
//   `needsMachine` (a raw literal cannot, so it must be served).
// - a CONFIG document a scoped web plugin registers (`ConfigV2.WebRegister`)
//   is registered (`ConfigV2.Register`) by a graph member's `server/` barrel.
//   There is no `needsMachine` escape for config. This arm reads the barrels'
//   contributions (`collectConfigRegistrations`), so it runs where barrels are
//   imported — `config-v2:registrations-paired` — never in the barrel-free
//   registry phase the graph itself is derived in.
//
// Nothing here is exemptable: a gap is cleared by making the serving barrel
// portable, splitting what it serves into a portable `server/` half, or
// declaring the declaration `needsMachine` — and every failure names the key,
// the reader (file:line), the serving plugin and why it is outside the graph.
//
// "Referenced" is read from source text, never evaluated: every non-test file
// of a scoped plugin's `web/` and own `shared/`, plus — transitively — every
// `web/`, `shared/` or `core/` module a reader imports a name from (the core
// helper that builds an asset path from an endpoint is as much a reader as the
// component calling it). An imported name is resolved through barrels and
// re-exports to the file that declares it.
//
// A file that imports `pageTransport` (sanctioned by
// `networking/no-page-transport`: telemetry, boot, the page's icon sprites) is
// PAGE-BOUND: the endpoints it calls go to the page's server through
// `fetchEndpointOver(pageTransport)`, so its endpoints (and raw `/api` URLs)
// are not the scope's. Everything else in it still is — a live read always
// goes through the context transport, the scope's inside one — and it may not
// hold a scope fetcher too (`useFetchEndpoint`, a `FetchEndpoint` parameter,
// `useEndpoint`, `useEndpointMutation`): a module is the page's or the scope's,
// never both, or a scope call hidden in it would escape the endpoint arm.

import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { importClosure } from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import {
  isPlatformApi,
  platformGlobalsIn,
} from "@plugins/framework/plugins/tooling/plugins/boundaries/core";
import {
  asFsPath,
  isTestCodePath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  endpointExports,
  findImports,
  findMarkerCalls,
  isPortableServerBarrel,
  lineAt,
  markerCallSpans,
  maskSource,
  matchBracket,
  type EndpointExport,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import {
  buildDescriptorIndex,
  isResourceVocabularyOwner,
  parseFileBindings,
  registerCallTarget,
  resourceDescriptorFactories,
  resourceRegisterMarkers,
  type DescriptorInfo,
  type ImportedDescriptorResolver,
} from "@plugins/framework/plugins/tooling/plugins/resource-vocabulary/core";
import { RESOURCE_HTTP_ROUTE } from "@plugins/packages/plugins/resource-protocol/core";

/** One live read the scoped page references, as the generated `hostReads` lists it. */
export interface HostRead {
  /** The declaration's key (a collection's own key — its mints share it). */
  key: string;
  /** Declared `needsMachine`: the page renders it "not available", nothing is asked. */
  needsMachine: boolean;
}

/** The inputs of {@link resolveHostCoverage}, each already read off the repo. */
export interface HostCoverageInputs {
  /** Who the coverage is for, in errors (`<declaration> (composition "<name>")`). */
  label: string;
  /** The graph's members, by plugin path (`a/plugins/b`). */
  members: readonly string[];
  /** The scoped web plugins, by dot id. */
  webPlugins: readonly PluginId[];
  /** The composition's whole bundle, by dot id — "not in the composition" vs "not portable". */
  bundle: ReadonlySet<string>;
  /** The run's file set. */
  repo: Pick<RepoFiles, "has" | "under" | "read">;
  /**
   * What keeps a non-portable server barrel outside the graph: the
   * non-portable barrels it reaches and its own modules that need the
   * computer. Asked only to explain a failure.
   */
  blockers(barrel: string): Promise<string[]>;
}

/** What a scoped page uses, all covered. */
export interface HostCoverage {
  /** Every live read the scope references, sorted by key. */
  reads: HostRead[];
}

// ── Paths ─────────────────────────────────────────────────────────────────

/** A repo path's plugin (`a/plugins/b`) and the folder it sits in, or null outside a plugin folder. */
function locate(path: string): { plugin: string; folder: string } | null {
  if (!path.startsWith("plugins/")) return null;
  const segs = path.slice("plugins/".length).split("/");
  const plugin = [segs[0]!];
  let i = 1;
  while (segs[i] === "plugins" && i + 1 < segs.length - 1) {
    plugin.push(segs[i + 1]!);
    i += 2;
  }
  if (i >= segs.length - 1) return null;
  return { plugin: plugin.join("/plugins/"), folder: segs[i]! };
}

const dotId = (plugin: string): string => plugin.split("/plugins/").join(".");

const SERVER_BARREL_RE =
  /^plugins\/((?:[^/]+\/plugins\/)*[^/]+)\/server\/index\.ts$/;

const BACKEND_FOLDERS = ["server", "machine", "central"] as const;

const SOURCE_RE = /\.tsx?$/;

const isSource = (path: string): boolean =>
  SOURCE_RE.test(path) && !isTestCodePath(path.split("/"));

/** Every non-test source file directly owned by `plugin`'s `folder/` (no child plugin). */
function folderFiles(
  repo: HostCoverageInputs["repo"],
  plugin: string,
  folder: string,
): string[] {
  return repo.under(`plugins/${plugin}/${folder}`).filter(isSource);
}

/** Every non-test source file of `plugin` itself, in any folder (no child plugin). */
function pluginFiles(
  repo: HostCoverageInputs["repo"],
  plugin: string,
): string[] {
  return repo
    .under(`plugins/${plugin}`)
    .filter((p) => isSource(p) && locate(p)?.plugin === plugin);
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** The repo module a specifier names from `importer`, or null (an npm package, an asset). */
function resolveModule(
  repo: HostCoverageInputs["repo"],
  importer: string,
  specifier: string,
): string | null {
  let base: string;
  if (specifier.startsWith("@plugins/")) {
    base = `plugins/${specifier.slice("@plugins/".length)}`;
  } else if (specifier.startsWith(".")) {
    const dir = importer.slice(0, importer.lastIndexOf("/"));
    base = normalize(`${dir}/${specifier}`);
  } else {
    return null;
  }
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (SOURCE_RE.test(candidate) && repo.has(candidate)) return candidate;
  }
  return null;
}

// ── Source reading ────────────────────────────────────────────────────────

/** One file's source, its masked twin and what it declares — read once per run. */
interface Module {
  path: string;
  src: string;
  masked: string;
  /** Exported names re-exported from another module: name → (module, its name there). */
  reexports: Map<string, { from: string; name: string }>;
  /** `export * from …` targets. */
  stars: string[];
  /** Names declared in this file (`const` / `function` / `class` …). */
  locals: Set<string>;
  /** Imported value bindings: local → (module, exported name), with the import's line. */
  imports: Map<string, { from: string; name: string; line: number }>;
  /** Whether it imports `pageTransport` (talks to the page's own server). */
  pageBound: boolean;
}

/**
 * The imports that bind a module to the page's own server — `pageTransport`
 * and the page pipeline's live-state client accessors, the names
 * `networking/no-page-transport` sanctions one importer at a time.
 */
const PAGE_BOUND_IMPORTS: ReadonlySet<string> = new Set([
  "pageTransport",
  "getNotificationsClient",
  "ensureNotificationsClient",
]);

/** A scope fetcher (the subtree's transport) named in a module. */
const SCOPE_FETCHER_RE =
  /\b(?:useFetchEndpoint|FetchEndpoint|useEndpoint|useEndpointMutation)\b/;

const DECL_RE =
  /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|enum)\s+([A-Za-z_$][\w$]*)/gm;
const LOCAL_EXPORT_LIST_RE = /\bexport\s+(type\s+)?\{([^}]*)\}/g;

function createReader(repo: HostCoverageInputs["repo"]) {
  const modules = new Map<string, Promise<Module | null>>();
  const load = async (path: string): Promise<Module | null> => {
    const src = await repo.read(path);
    if (src === null) return null;
    const masked = maskSource(src);
    const locals = new Set<string>();
    for (const m of masked.matchAll(DECL_RE)) locals.add(m[1]!);
    const reexports = new Map<string, { from: string; name: string }>();
    const stars: string[] = [];
    const imports = new Map<
      string,
      { from: string; name: string; line: number }
    >();
    let pageBound = false;
    for (const ref of findImports(src)) {
      if (ref.sideEffect) continue;
      const target = resolveModule(repo, path, ref.specifier);
      const clause = ref.clause.trim();
      if (ref.keyword === "export") {
        if (target === null || ref.typeOnly) continue;
        if (/^\*\s*$/.test(clause)) {
          stars.push(target);
          continue;
        }
        for (const item of namedItems(clause)) {
          if (!item.typeOnly)
            reexports.set(item.local, { from: target, name: item.imported });
        }
        continue;
      }
      for (const item of namedItems(clause)) {
        if (ref.typeOnly || item.typeOnly) continue;
        if (PAGE_BOUND_IMPORTS.has(item.imported)) pageBound = true;
        if (target === null) continue;
        imports.set(item.local, {
          from: target,
          name: item.imported,
          line: lineAt(src, ref.index),
        });
      }
    }
    // `export { a as b }` with no `from`: a local (or imported) name, exported.
    for (const m of masked.matchAll(LOCAL_EXPORT_LIST_RE)) {
      if (m[1] !== undefined) continue;
      const after = masked.slice(m.index + m[0].length).trimStart();
      if (after.startsWith("from")) continue;
      for (const item of namedItems(`{${m[2]!}}`)) {
        if (item.typeOnly || item.local === item.imported) continue;
        const imported = imports.get(item.imported);
        if (imported !== undefined) reexports.set(item.local, imported);
        else locals.add(item.local);
      }
    }
    return {
      path,
      src,
      masked,
      reexports,
      stars,
      locals,
      imports,
      pageBound,
    };
  };
  return (path: string): Promise<Module | null> => {
    let m = modules.get(path);
    if (m === undefined) {
      m = load(path);
      modules.set(path, m);
    }
    return m;
  };
}

/**
 * The named items of an import/export clause (`{ a, b as c, type D }`), as
 * `imported` (the name in the source module) and `local` (the name here — for
 * an export list, the exported name). A default or namespace binding is not a
 * named item and is skipped.
 */
function namedItems(
  clause: string,
): { imported: string; local: string; typeOnly: boolean }[] {
  const open = clause.indexOf("{");
  const close = clause.lastIndexOf("}");
  if (open < 0 || close < open) return [];
  const out: { imported: string; local: string; typeOnly: boolean }[] = [];
  for (const raw of clause.slice(open + 1, close).split(",")) {
    const item = raw.trim();
    if (item === "") continue;
    const typeOnly = /^type\s+/.test(item);
    const m =
      /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(
        item,
      );
    if (m === null) continue;
    out.push({ imported: m[1]!, local: m[2] ?? m[1]!, typeOnly });
  }
  return out;
}

// ── The guard ─────────────────────────────────────────────────────────────

type Declaration =
  | {
      kind: "read";
      file: string;
      name: string;
      key: string;
      keys: string[];
      needsMachine: boolean;
      origin: "central" | null;
    }
  | { kind: "endpoint"; file: string; name: string; endpoint: EndpointExport };

/** Where a declaration is referenced from. */
interface Reader {
  file: string;
  line: number;
}

/**
 * Every declaration the scope references, whether the host serves it, and the
 * reads it ends with. THROWS — naming each gap's key, reader, serving plugin
 * and why it is outside the graph — rather than emit a host whose page would
 * hit "not served by this host".
 */
export async function resolveHostCoverage(
  inputs: HostCoverageInputs,
): Promise<HostCoverage> {
  const { repo, label } = inputs;
  const read = createReader(repo);
  const members = new Set(inputs.members);

  // Descriptor and endpoint declarations, per file, memoized.
  const indexes = new Map<string, Map<string, DescriptorInfo[]>>();
  const descriptorsOf = (m: Module): Map<string, DescriptorInfo[]> => {
    let index = indexes.get(m.path);
    if (index === undefined) {
      const plugin = locate(m.path)?.plugin ?? "";
      index = buildDescriptorIndex([{ path: m.path, src: m.src }], {
        ownerPlugin: isResourceVocabularyOwner(`plugins/${plugin}`),
      });
      indexes.set(m.path, index);
    }
    return index;
  };
  const endpointsOf = new Map<string, EndpointExport[]>();
  const endpointsIn = (m: Module): EndpointExport[] => {
    let list = endpointsOf.get(m.path);
    if (list === undefined) {
      list = endpointExports(m.path, m.src);
      endpointsOf.set(m.path, list);
    }
    return list;
  };
  const declarationIn = (m: Module, name: string): Declaration | null => {
    const infos = descriptorsOf(m).get(name);
    if (infos !== undefined && infos.length > 0) {
      const keys = infos.map((i) => i.key);
      return {
        kind: "read",
        file: m.path,
        name,
        key: declarationKey(keys[0]!),
        keys,
        needsMachine: infos.some((i) => i.needsMachine === true),
        origin: infos.some((i) => i.origin === "central") ? "central" : null,
      };
    }
    const endpoint = endpointsIn(m).find((e) => e.name === name);
    if (endpoint !== undefined) {
      return { kind: "endpoint", file: m.path, name, endpoint };
    }
    return null;
  };

  /** The file declaring `name` as `module` exports it, through re-exports. */
  const resolveExport = async (
    module: string,
    name: string,
    seen = new Set<string>(),
  ): Promise<{ module: Module; name: string } | null> => {
    const key = `${module}#${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const m = await read(module);
    if (m === null) return null;
    const re = m.reexports.get(name);
    if (re !== undefined) return resolveExport(re.from, re.name, seen);
    if (m.locals.has(name)) return { module: m, name };
    for (const star of m.stars) {
      const hit = await resolveExport(star, name, seen);
      if (hit !== null) return hit;
    }
    return null;
  };

  // ── What the scope references ──
  const references = new Map<string, { decl: Declaration; at: Reader[] }>();
  const note = (decl: Declaration, at: Reader): void => {
    const id =
      decl.kind === "read" ? `read:${decl.key}` : `ep:${decl.endpoint.route}`;
    const entry = references.get(id) ?? { decl, at: [] };
    entry.at.push(at);
    references.set(id, entry);
  };
  const rawApi = new Map<string, Reader[]>();

  const readers: string[] = [];
  const queued = new Set<string>();
  const enqueue = (path: string): void => {
    if (queued.has(path) || !isSource(path)) return;
    const where = locate(path);
    if (where === null) return;
    if (!["web", "shared", "core"].includes(where.folder)) return;
    queued.add(path);
    readers.push(path);
  };
  for (const id of inputs.webPlugins) {
    const plugin = asFsPath(id);
    for (const folder of ["web", "shared"]) {
      for (const path of folderFiles(repo, plugin, folder)) enqueue(path);
    }
  }

  const mixed: Reader[] = [];
  for (let i = 0; i < readers.length; i++) {
    const m = await read(readers[i]!);
    if (m === null) continue;
    // A page-bound module's endpoints are the page's (see the header); a
    // scope fetcher beside them is refused, not skipped.
    if (m.pageBound) {
      const scopeFetcher = SCOPE_FETCHER_RE.exec(m.masked);
      if (scopeFetcher !== null) {
        mixed.push({ file: m.path, line: lineAt(m.src, scopeFetcher.index) });
      }
    }
    const counts = (decl: Declaration): boolean =>
      !(m.pageBound && decl.kind === "endpoint");
    for (const imp of m.imports.values()) {
      const hit = await resolveExport(imp.from, imp.name);
      if (hit === null) continue;
      const decl = declarationIn(hit.module, hit.name);
      if (decl === null) {
        // A helper: its own file reads too (the core it imports).
        enqueue(hit.module.path);
        continue;
      }
      if (counts(decl)) note(decl, { file: m.path, line: imp.line });
    }
    // A declaration this same file uses (a core helper building an asset path
    // from the endpoint declared beside it).
    for (const name of m.locals) {
      const decl = declarationIn(m, name);
      if (decl === null || !counts(decl)) continue;
      const uses = [...m.masked.matchAll(new RegExp(`\\b${name}\\b`, "g"))];
      if (uses.length < 2) continue;
      note(decl, { file: m.path, line: lineAt(m.src, uses[1]!.index) });
    }
    // A raw `/api/<prefix>` URL the file builds by hand: a string literal
    // that STARTS with it (a route string `"GET /api/…"` or prose naming one
    // is not a URL). A page-bound module's is the page's.
    if (!m.pageBound && m.src.includes("/api/")) {
      // Sanctioned token-in-string scan (as the routes facet's caller join):
      // the URL lives inside a string, so strings are kept; comments are not.
      const kept = maskSource(m.src, { strings: false });
      for (const hit of kept.matchAll(/["'`]\/api\/([A-Za-z0-9_-]+)/g)) {
        const list = rawApi.get(hit[1]!) ?? [];
        list.push({ file: m.path, line: lineAt(m.src, hit.index) });
        rawApi.set(hit[1]!, list);
      }
    }
  }

  // ── What the graph serves ──
  const wrappers = await serveWrappers(repo, read, resolveExport);
  const servedKeys = new Set<string>();
  // Every host mounts its resource runtime's own HTTP read (server-core's host
  // routes), whatever its graph.
  const servedRoutes = new Set<string>([RESOURCE_HTTP_ROUTE]);
  for (const plugin of members) {
    const files = folderFiles(repo, plugin, "server");
    for (const key of await registeredKeys(
      repo,
      read,
      resolveExport,
      wrappers,
      plugin,
      files,
    ))
      servedKeys.add(key);
    for (const route of await httpRoutes(
      read,
      resolveExport,
      `plugins/${plugin}/server/index.ts`,
    ))
      servedRoutes.add(route);
  }

  // ── The verdict ──
  const problems: string[] = mixed.map(
    (r) =>
      `${r.file}:${r.line} imports \`pageTransport\` and holds a scope fetcher too — a module is the page's (its endpoints reach the page's server) or the scope's, never both: move the scope's calls into a module of their own`,
  );
  const reads: HostRead[] = [];
  let servers: Promise<ServerIndex> | null = null;
  const explain = async (
    what: { key: string } | { route: string } | { prefix: string },
  ): Promise<string> => {
    servers ??= indexServers(repo, read, resolveExport, wrappers);
    const index = await servers;
    const sites =
      "key" in what
        ? (index.keys.get(what.key) ?? [])
        : "route" in what
          ? (index.routes.get(what.route) ?? [])
          : [...index.routes]
              .filter(([r]) => routePrefix(r) === what.prefix)
              .flatMap(([, s]) => s);
    if (sites.length === 0) return "nothing in the repo serves it";
    const lines: string[] = [];
    for (const site of uniqueSites(sites)) {
      lines.push(await whyOutside(site, inputs, members, true));
    }
    return lines.join("; ");
  };

  for (const { decl, at } of [...references.values()].sort((a, b) =>
    sortKey(a.decl).localeCompare(sortKey(b.decl)),
  )) {
    const where = at
      .slice(0, 3)
      .map((r) => `${r.file}:${r.line}`)
      .join(", ");
    const more = at.length > 3 ? ` (+${at.length - 3} more)` : "";
    if (decl.kind === "read") {
      reads.push({ key: decl.key, needsMachine: decl.needsMachine });
      if (decl.needsMachine) continue;
      if (decl.origin === "central") {
        problems.push(
          `live read "${decl.key}" (${decl.file}) is central's (origin: "central") and not \`needsMachine\` — no browser host runs central\n      read at ${where}${more}`,
        );
        continue;
      }
      if (decl.keys.some((k) => servedKeys.has(k))) continue;
      problems.push(
        `live read "${decl.key}" (${decl.file}) is not served by the graph: ${await explain({ key: decl.keys[0]! })}\n      read at ${where}${more}`,
      );
      continue;
    }
    const { route, needsMachine } = decl.endpoint;
    if (needsMachine || servedRoutes.has(route)) continue;
    problems.push(
      `endpoint "${route}" (${decl.name}, ${decl.file}) is not served by the graph: ${await explain({ route })}\n      called at ${where}${more}`,
    );
  }

  const servedPrefixes = new Set([...servedRoutes].map(routePrefix));
  for (const [prefix, at] of [...rawApi].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (servedPrefixes.has(prefix)) continue;
    // A prefix no backend barrel declares a route under is a dynamically
    // registered one (the asset mirror's): nothing here can judge it. Its
    // in-scope consumer gates on the transport (`servesUrls`) instead — a
    // URL handed to a third-party fetcher is a sink no text scan can see.
    servers ??= indexServers(repo, read, resolveExport, wrappers);
    const index = await servers;
    if (![...index.routes.keys()].some((r) => routePrefix(r) === prefix))
      continue;
    const where = at
      .slice(0, 3)
      .map((r) => `${r.file}:${r.line}`)
      .join(", ");
    problems.push(
      `a raw "/api/${prefix}" URL is not served by the graph (a URL built by hand cannot declare \`needsMachine\` — call the endpoint through \`useFetchEndpoint\`, or build an \`AssetPath\` from it): ${await explain({ prefix })}\n      named at ${where}${at.length > 3 ? ` (+${at.length - 3} more)` : ""}`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `${label}: ${problems.length} declaration(s) the scoped page uses have no answer on the host — each must be served by a graph member's \`server/\` (make the serving barrel \`portable: true\`, or split what it serves into a portable \`server/\` half) or declare \`needsMachine\`:\n  - ${problems.join("\n  - ")}`,
    );
  }
  return {
    reads: dedupeReads(reads),
  };
}

const sortKey = (d: Declaration): string =>
  d.kind === "read" ? `0 ${d.key}` : `1 ${d.endpoint.route}`;

function dedupeReads(reads: HostRead[]): HostRead[] {
  const byKey = new Map<string, HostRead>();
  for (const r of reads) byKey.set(r.key, r);
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Every suffix a factory call mints beside its key (`:rows`, `:groups`, …). */
const MINT_SUFFIXES = [
  ...new Set(
    Object.values(resourceDescriptorFactories).flatMap((f) =>
      f.mints.map((m) => m.suffix).filter((x) => x !== ""),
    ),
  ),
];

/** A minted key's declaration key: `"k:rows"` → `"k"`. */
function declarationKey(minted: string): string {
  const suffix = MINT_SUFFIXES.find((x) => minted.endsWith(x));
  return suffix === undefined ? minted : minted.slice(0, -suffix.length);
}

/** `"GET /api/tasks/:id"` → `"tasks"` (the segment after `/api/`), or null. */
function routePrefix(route: string): string | null {
  return /^\S+\s+\/api\/([A-Za-z0-9_-]+)/.exec(route)?.[1] ?? null;
}

type ReadModule = (path: string) => Promise<Module | null>;
type ResolveExport = (
  module: string,
  name: string,
) => Promise<{ module: Module; name: string } | null>;

/**
 * The keys `plugin`'s `files` serve: every register call's descriptor, resolved
 * through the plugin's own declarations and, for an imported descriptor, the
 * declaring plugin's — the docs facet's reading (`registerCallTarget`). A call
 * to a serving WRAPPER (`serveTranscriptValue(value, derive)`: a function
 * handing its first parameter to a register call) counts as a register call.
 */
async function registeredKeys(
  repo: HostCoverageInputs["repo"],
  read: ReadModule,
  resolveExport: ResolveExport,
  wrappers: ReadonlySet<string>,
  plugin: string,
  files: readonly string[],
): Promise<string[]> {
  const sources = async (paths: readonly string[]) =>
    (await Promise.all(paths.map((p) => read(p)))).flatMap((m) =>
      m === null ? [] : [{ path: m.path, src: m.src }],
    );
  const own = buildDescriptorIndex(await sources(pluginFiles(repo, plugin)), {
    ownerPlugin: isResourceVocabularyOwner(`plugins/${plugin}`),
  });
  const others = new Map<string, Map<string, DescriptorInfo[]>>();
  const otherIndex = async (specifier: string) => {
    const dir = specifier.replace(/^@plugins\//, "").replace(/\/[^/]+$/, "");
    let index = others.get(dir);
    if (index === undefined) {
      index = buildDescriptorIndex(await sources(pluginFiles(repo, dir)), {
        ownerPlugin: isResourceVocabularyOwner(`plugins/${dir}`),
      });
      others.set(dir, index);
    }
    return index;
  };
  const keys: string[] = [];
  for (const path of files) {
    const m = await read(path);
    if (m === null) continue;
    const markers = Object.keys(resourceRegisterMarkers).filter((k) =>
      m.src.includes(k),
    );
    // The serving wrappers this file calls, by their local name.
    for (const [local, imp] of m.imports) {
      const hit = await resolveExport(imp.from, imp.name);
      if (hit !== null && wrappers.has(`${hit.module.path}#${hit.name}`))
        markers.push(local);
    }
    for (const name of m.locals) {
      if (wrappers.has(`${m.path}#${name}`)) markers.push(name);
    }
    if (markers.length === 0) continue;
    const bindings = parseFileBindings(m.src);
    // Imported descriptors resolve through the declaring plugin's index,
    // prepared before the (synchronous) scan asks for it.
    const imported = new Map<string, Map<string, DescriptorInfo[]>>();
    for (const b of bindings.values()) {
      if (b.specifier?.startsWith("@plugins/") === true && !b.typeOnly) {
        imported.set(b.specifier, await otherIndex(b.specifier));
      }
    }
    const resolveImported: ImportedDescriptorResolver = (specifier, name) =>
      imported.get(specifier)?.get(name) ?? null;
    for (const marker of markers) {
      for (const call of findMarkerCalls(m.src, marker)) {
        const target = registerCallTarget(
          marker,
          call.argsText,
          bindings,
          own,
          { file: path, line: lineAt(m.src, call.index) },
          resolveImported,
        );
        if (target === null) continue;
        if (target.kind === "literal") keys.push(target.key);
        else for (const info of target.infos) keys.push(info.key);
      }
    }
  }
  return keys;
}

/**
 * Every serving wrapper of the repo's backend code, as `<module>#<name>`: a
 * function whose first parameter is the first argument of a register call in
 * its body (or of another wrapper's, to a fixpoint) — so a call to it serves
 * the descriptor it is handed. A text scan cannot follow the descriptor
 * through the parameter; it can see the wrapper.
 */
async function serveWrappers(
  repo: HostCoverageInputs["repo"],
  read: ReadModule,
  resolveExport: ResolveExport,
): Promise<Set<string>> {
  const candidates: Module[] = [];
  for (const path of repo.under("plugins")) {
    const where = locate(path);
    if (where === null || !isSource(path)) continue;
    if (!(BACKEND_FOLDERS as readonly string[]).includes(where.folder))
      continue;
    const m = await read(path);
    if (m !== null) candidates.push(m);
  }
  const wrappers = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const m of candidates) {
      // The names this module may call to serve: the markers, and the
      // wrappers it imports or declares.
      const markers = Object.keys(resourceRegisterMarkers).filter((k) =>
        m.src.includes(k),
      );
      for (const [local, imp] of m.imports) {
        const hit = await resolveExport(imp.from, imp.name);
        if (hit !== null && wrappers.has(`${hit.module.path}#${hit.name}`))
          markers.push(local);
      }
      for (const name of m.locals) {
        if (wrappers.has(`${m.path}#${name}`)) markers.push(name);
      }
      if (markers.length === 0) continue;
      for (const fn of functionsOf(m.masked)) {
        const id = `${m.path}#${fn.name}`;
        if (wrappers.has(id)) continue;
        const body = m.masked.slice(fn.bodyStart, fn.bodyEnd);
        const served = markers.some((marker) =>
          markerCallSpans(body, marker).some(
            (span) =>
              new RegExp(`^\\s*${fn.param}\\s*[,)]`).exec(
                body.slice(span.open + 1, span.close + 1),
              ) !== null,
          ),
        );
        if (!served) continue;
        wrappers.add(id);
        grew = true;
      }
    }
  }
  return wrappers;
}

/** Module-level functions of a masked source: name, first parameter, body span. */
function functionsOf(
  masked: string,
): { name: string; param: string; bodyStart: number; bodyEnd: number }[] {
  const out: {
    name: string;
    param: string;
    bodyStart: number;
    bodyEnd: number;
  }[] = [];
  const re =
    /^(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(|const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:<[^>(]*>)?\s*\()/gm;
  for (const m of masked.matchAll(re)) {
    const name = (m[1] ?? m[2])!;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open, "(", ")");
    if (close < 0) continue;
    const param = /^\s*([A-Za-z_$][\w$]*)/.exec(masked.slice(open + 1, close));
    if (param === null) continue;
    // The body: the next `{ … }` after the parameters (a function's, or an
    // arrow's block); an expression-bodied arrow runs to the statement's end.
    const rest = masked.slice(close + 1);
    const brace = /^\s*(?::[^{=]*)?(?:=>)?\s*\{/.exec(rest);
    let bodyStart: number;
    let bodyEnd: number;
    if (brace !== null) {
      bodyStart = close + 1 + brace[0].length - 1;
      bodyEnd = matchBracket(masked, bodyStart, "{", "}");
      if (bodyEnd < 0) continue;
    } else {
      bodyStart = close + 1;
      const end = masked.indexOf(";\n", bodyStart);
      bodyEnd = end < 0 ? masked.length : end;
    }
    out.push({ name, param: param[1]!, bodyStart, bodyEnd: bodyEnd + 1 });
  }
  return out;
}

/**
 * The HTTP routes a backend barrel's `httpRoutes` serves: a literal
 * `"METHOD /path"` key, or a computed `[endpoint.route]` resolved to the
 * endpoint's declaration.
 */
async function httpRoutes(
  read: ReadModule,
  resolveExport: ResolveExport,
  barrel: string,
): Promise<string[]> {
  const m = await read(barrel);
  if (m === null) return [];
  const at = m.masked.search(/\bhttpRoutes\s*:\s*\{/);
  if (at < 0) return [];
  const open = m.masked.indexOf("{", at);
  let depth = 0;
  let close = -1;
  for (let i = open; i < m.masked.length; i++) {
    const c = m.masked[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) return [];
  const routes: string[] = [];
  const block = m.masked.slice(open + 1, close);
  for (const k of block.matchAll(
    /\[\s*([A-Za-z_$][\w$]*)\s*\.\s*route\s*\]/g,
  )) {
    const local = k[1]!;
    const imp = m.imports.get(local);
    const hit =
      imp !== undefined
        ? await resolveExport(imp.from, imp.name)
        : { module: m, name: local };
    if (hit === null) continue;
    const e = endpointExports(hit.module.path, hit.module.src).find(
      (x) => x.name === hit.name,
    );
    if (e !== undefined) routes.push(e.route);
  }
  // Literal keys: the masked block blanks string interiors (offsets kept), so
  // each quoted key is located there and read back from the original.
  const original = m.src.slice(open + 1, close);
  for (const k of block.matchAll(/(["'`])([^"'`]*)\1\s*:/g)) {
    const text = original.slice(k.index + 1, k.index + 1 + k[2]!.length);
    if (/^[A-Z]+\s+\//.test(text)) routes.push(text);
  }
  return routes;
}

// ── Explaining a gap ──────────────────────────────────────────────────────

/**
 * What keeps the non-portable server `barrel` out of a browser host, read off
 * its static closure: the non-portable server barrels it reaches first (each
 * with its import chain — a frontier: one reached only through another is not
 * named), and its own plugin's modules that need the computer (the platform
 * APIs they import, the host globals they read) — the reading
 * `boundaries:portable-closure` makes of a portable barrel.
 */
export async function serverBarrelBlockers(
  root: string,
  repo: Pick<RepoFiles, "read">,
  barrel: string,
): Promise<string[]> {
  const closure = await importClosure(root, barrel, { dynamicImports: "cut" });
  const own = barrel.replace(/server\/index\.ts$/, "");
  const blocked = new Set<string>();
  for (const module of closure.modules) {
    if (module === barrel || !SERVER_BARREL_RE.test(module)) continue;
    const src = await repo.read(module);
    if (src !== null && !isPortableServerBarrel(src)) blocked.add(module);
  }
  const out: string[] = [];
  for (const module of [...blocked].sort()) {
    const chain = closure.importChain(module);
    if (chain.slice(1, -1).some((m) => blocked.has(m))) continue;
    out.push(
      `${locate(module)!.plugin}/server is not portable (via ${chain.join(" → ")})`,
    );
  }
  for (const module of [...closure.modules].sort()) {
    if (!module.startsWith(`${own}server/`)) continue;
    const src = await repo.read(module);
    if (src === null) continue;
    const needs = [
      ...new Set(
        findImports(src)
          .filter((ref) => !ref.typeOnly && isPlatformApi(ref.specifier))
          .map((ref) => ref.specifier),
      ),
      ...platformGlobalsIn(maskSource(src)).map((g) => `global ${g}`),
    ];
    if (needs.length > 0) out.push(`${module} needs ${needs.join(", ")}`);
  }
  return out;
}

/** Where something is served, anywhere in the repo. */
interface ServeSite {
  plugin: string;
  folder: string;
  file: string;
}

interface ServerIndex {
  keys: Map<string, ServeSite[]>;
  routes: Map<string, ServeSite[]>;
}

/** Every key and route every backend folder of the repo serves — read only to explain a failure. */
async function indexServers(
  repo: HostCoverageInputs["repo"],
  read: ReadModule,
  resolveExport: ResolveExport,
  wrappers: ReadonlySet<string>,
): Promise<ServerIndex> {
  const keys = new Map<string, ServeSite[]>();
  const routes = new Map<string, ServeSite[]>();
  const add = (
    map: Map<string, ServeSite[]>,
    k: string,
    site: ServeSite,
  ): void => {
    const list = map.get(k) ?? [];
    list.push(site);
    map.set(k, list);
  };
  const plugins = new Map<string, Set<string>>();
  for (const path of repo.under("plugins")) {
    const where = locate(path);
    if (where === null || !isSource(path)) continue;
    if (!(BACKEND_FOLDERS as readonly string[]).includes(where.folder))
      continue;
    const set = plugins.get(where.plugin) ?? new Set<string>();
    set.add(where.folder);
    plugins.set(where.plugin, set);
  }
  for (const [plugin, folders] of plugins) {
    for (const folder of folders) {
      const files = folderFiles(repo, plugin, folder);
      const barrel = `plugins/${plugin}/${folder}/index.ts`;
      const site = { plugin, folder, file: barrel };
      for (const key of await registeredKeys(
        repo,
        read,
        resolveExport,
        wrappers,
        plugin,
        files,
      )) {
        add(keys, key, site);
      }
      for (const route of await httpRoutes(read, resolveExport, barrel)) {
        add(routes, route, site);
      }
    }
  }
  return { keys, routes };
}

function uniqueSites(sites: readonly ServeSite[]): ServeSite[] {
  const seen = new Set<string>();
  return sites.filter((s) => {
    const k = `${s.plugin}/${s.folder}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Why one serving site is outside the graph. `needsMachine` says whether the
 * declaration may declare it (a read or an endpoint may; config may not), so
 * the advice names only a fix that exists.
 */
async function whyOutside(
  site: ServeSite,
  inputs: Pick<HostCoverageInputs, "bundle" | "blockers">,
  members: ReadonlySet<string>,
  needsMachine: boolean,
): Promise<string> {
  const where = `${site.plugin}/${site.folder}`;
  if (site.folder === "machine") {
    return needsMachine
      ? `served by ${where} — desktop-only (no browser host boots \`machine/\`): declare it \`needsMachine\`, or move its serving into a portable \`server/\``
      : `served by ${where} — desktop-only (no browser host boots \`machine/\`): move it into the plugin's portable \`server/\``;
  }
  if (site.folder === "central") {
    return needsMachine
      ? `served by ${where} — central's, which no browser host runs: declare it \`needsMachine\``
      : `served by ${where} — central's, which no browser host runs`;
  }
  if (members.has(site.plugin)) {
    return `served by ${where}, a graph member — but not from its \`server/\` files the guard reads`;
  }
  if (!inputs.bundle.has(dotId(site.plugin))) {
    return `served by ${where}, which is not in the composition`;
  }
  const blockers = await inputs.blockers(site.file);
  return blockers.length === 0
    ? `served by ${where}, which is not \`portable: true\` (nothing in its closure needs the computer: flip it)`
    : `served by ${where}, which is not portable: ${blockers.slice(0, 4).join("; ")}${blockers.length > 4 ? ` (+${blockers.length - 4} more)` : ""}`;
}

// ── The config arm ────────────────────────────────────────────────────────

/** One config registration, located — `config_v2`'s `collectConfigRegistrations` row. */
export interface HostConfigRegistration {
  runtime: "web" | "server" | "machine";
  /** The plugin whose barrel contributes it (dot id). */
  registrar: string;
  /** The plugin the descriptor is stored under (dot id). */
  owner: string;
  storePath: string;
  /** Repo-relative barrel the contribution was found in. */
  barrel: string;
}

/** The inputs of {@link resolveHostConfigCoverage}. */
export interface HostConfigCoverageInputs {
  label: string;
  members: readonly string[];
  webPlugins: readonly PluginId[];
  bundle: ReadonlySet<string>;
  /** Every config registration of the repo's barrels, every runtime. */
  registrations: readonly HostConfigRegistration[];
  blockers(barrel: string): Promise<string[]>;
}

/**
 * The config arm of the coverage guard (see the header): every
 * `ConfigV2.WebRegister` a scoped web plugin contributes — for a descriptor
 * whose owner is scoped too (reorder plants one directive per slot under the
 * slot's declaring plugin; a slot no scoped plugin declares is never read) —
 * has a `ConfigV2.Register` at the same storePath in a graph member's
 * `server/` barrel, or `useConfig` throws inside the scope. No `needsMachine`
 * escape: a document the page reads is served, or the page does not read it.
 * Returns one line per unserved storePath, naming the scoped registrar, every
 * server-side registrar and why it is outside the graph.
 */
export async function resolveHostConfigCoverage(
  inputs: HostConfigCoverageInputs,
): Promise<string[]> {
  const scope = new Set<string>(inputs.webPlugins);
  const members = new Set(inputs.members.map(dotId));
  const memberPaths = new Set(inputs.members);
  const serverSide = new Map<string, HostConfigRegistration[]>();
  for (const r of inputs.registrations) {
    if (r.runtime === "web") continue;
    serverSide.set(r.storePath, [...(serverSide.get(r.storePath) ?? []), r]);
  }
  const required = new Map<string, HostConfigRegistration[]>();
  for (const r of inputs.registrations) {
    if (r.runtime !== "web" || !scope.has(r.registrar) || !scope.has(r.owner))
      continue;
    required.set(r.storePath, [...(required.get(r.storePath) ?? []), r]);
  }
  const problems: string[] = [];
  for (const [storePath, readers] of [...required].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const sites = serverSide.get(storePath) ?? [];
    if (sites.some((s) => s.runtime === "server" && members.has(s.registrar)))
      continue;
    const why =
      sites.length === 0
        ? "no ConfigV2.Register anywhere"
        : (
            await Promise.all(
              sites.map((s) => {
                const plugin = asFsPath(s.registrar as PluginId);
                return whyOutside(
                  { plugin, folder: s.runtime, file: s.barrel },
                  inputs,
                  memberPaths,
                  false,
                );
              }),
            )
          ).join("; ");
    problems.push(
      `config "${storePath}" registered on web by ${[...new Set(readers.map((r) => r.barrel))].join(", ")} is not served by the graph: ${why}`,
    );
  }
  return problems.map((p) => `${inputs.label}: ${p}`);
}

// ── The contributions arm ─────────────────────────────────────────────────

/**
 * One `defineServerContribution("<kind>", { … })` declaration: the contribution
 * kind its tokens stamp (`_kind.description`), and whether it declares
 * `absentOnHost` — a host may run without some of its contributors.
 */
export interface ServerContributionKindDecl {
  kind: string;
  absentOnHost: boolean;
}

/**
 * The contribution kinds `source` declares: each genuine
 * `defineServerContribution(…)` call (comments and strings masked) whose first
 * argument is a string literal. A call whose name is not a literal (the
 * function's own declaration) declares nothing a contribution can stamp.
 */
export function parseServerContributionDeclarations(
  source: string,
): ServerContributionKindDecl[] {
  const out: ServerContributionKindDecl[] = [];
  for (const call of findMarkerCalls(source, "defineServerContribution")) {
    const kind = /^\s*(["'`])([^"'`$]+)\1\s*(?:,|$)/.exec(call.argsText);
    if (kind === null) continue;
    out.push({
      kind: kind[2]!,
      absentOnHost: /\babsentOnHost\s*:/.test(maskSource(call.argsText)),
    });
  }
  return out;
}

/** A scoped web plugin's `server/` barrel outside the graph, as imported. */
export interface HostContributionBarrel {
  /** The plugin, by path (`a/plugins/b`). */
  plugin: string;
  /** Repo-relative barrel path. */
  barrel: string;
  /** Its contributions: each one's kind (`_kind.description`) and doc label. */
  contributions: readonly { kind: string; label?: string }[];
}

/** The inputs of {@link resolveHostContributionCoverage}. */
export interface HostContributionCoverageInputs {
  label: string;
  members: readonly string[];
  webPlugins: readonly PluginId[];
  /**
   * The `server/` barrels of the scoped web plugins that are NOT graph
   * members, imported (the caller imports exactly these).
   */
  barrels: readonly HostContributionBarrel[];
  /** Every declared contribution kind: kind → its declarations, by plugin path. */
  kinds: ReadonlyMap<
    string,
    readonly (ServerContributionKindDecl & { plugin: string })[]
  >;
  blockers(barrel: string): Promise<string[]>;
}

/**
 * The contributions arm of the coverage guard (see the header): a scoped web
 * plugin whose `server/` barrel the host does not boot must not contribute to
 * a kind a graph member declares — the member would answer the scoped page
 * without it (the task list's category labels, a list's exposed column, a
 * launch option the launch endpoint resolves). Unless the kind declares
 * `absentOnHost` (`defineServerContribution`): its contributions are the
 * contributor's own reaction or bookkeeping, read by nothing the host serves.
 *
 * A kind no member declares is not this arm's (no member reads it); a host
 * service's provider is the graph derivation's (`host-services.ts`). Runs
 * where barrels are imported (the `browser-host:contributions-covered`
 * check), never in the barrel-free registry phase. Nothing exempts it: a gap
 * is cleared by making the contributing barrel portable, moving the
 * contribution into a portable `server/` half, or — for a kind whose
 * contributions never shape an answer — declaring the kind `absentOnHost`.
 * Returns one line per contributing plugin.
 */
export async function resolveHostContributionCoverage(
  inputs: HostContributionCoverageInputs,
): Promise<string[]> {
  const members = new Set(inputs.members);
  const scope = new Set<string>(inputs.webPlugins.map((id) => asFsPath(id)));
  const problems: string[] = [];
  for (const b of [...inputs.barrels].sort((x, y) =>
    x.plugin.localeCompare(y.plugin),
  )) {
    if (members.has(b.plugin) || !scope.has(b.plugin)) continue;
    const gaps: string[] = [];
    for (const c of b.contributions) {
      if (c.kind.startsWith("host-service:")) continue;
      const decls = inputs.kinds.get(c.kind) ?? [];
      const declarers = decls.filter((d) => members.has(d.plugin));
      if (declarers.length === 0) continue;
      if (declarers.every((d) => d.absentOnHost)) continue;
      const label =
        c.label !== undefined && c.label.length > 60
          ? `${c.label.slice(0, 57)}…`
          : c.label;
      const what = label === undefined ? c.kind : `${c.kind} "${label}"`;
      gaps.push(
        `${what} (declared by ${[...new Set(declarers.map((d) => d.plugin))].join(", ")})`,
      );
    }
    if (gaps.length === 0) continue;
    const blockers = await inputs.blockers(b.barrel);
    const why =
      blockers.length === 0
        ? "it is not `portable: true` (nothing in its closure needs the computer: flip it)"
        : `it is not portable: ${blockers.slice(0, 4).join("; ")}${blockers.length > 4 ? ` (+${blockers.length - 4} more)` : ""}`;
    problems.push(
      `${inputs.label}: ${b.plugin}/server contributes to kinds a graph member reads, but the host does not boot it — ${why}\n      ${gaps.join("\n      ")}`,
    );
  }
  return problems;
}
