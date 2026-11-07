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
// - an ENDPOINT (a `defineEndpoint` it imports) is served by a graph member's
//   `server/` route — or declares `needsMachine`. A raw `/api/<prefix>`
//   literal fails whether served or not (but for the resource runtime's own
//   reads): a fetch of it is refused already, so it is a URL something loads
//   by itself, from the page's server rather than the worker.
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
// `useEndpointMutation`): a module is the page's or the scope's,
// never both, or a scope call hidden in it would escape the endpoint arm.

import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import type { ServerPortability } from "@plugins/framework/plugins/tooling/plugins/boundaries/core";
import {
  asFsPath,
  isTestCodePath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  findMarkerCalls,
  lineAt,
  maskSource,
  type EndpointExport,
  type ServerContributionKindDecl,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import {
  parseFileBindings,
  registerCallTarget,
  resourceDescriptorFactories,
  type DescriptorInfo,
  type FileBindings,
  type ImportedDescriptorResolver,
} from "@plugins/network/plugins/live/plugins/resource-vocabulary/core";
import { scanRepoFiles } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  coverageFactsScan,
  locate,
  unreadableRoute,
  type CallSite,
  type CoverageFacts,
} from "./browser-host-coverage.scan";
import {
  CENTRAL_RESOURCE_HTTP_ROUTE,
  RESOURCE_HTTP_ROUTE,
} from "@plugins/network/plugins/live/plugins/resource-protocol/core";

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
  /** The run's file set, as the snapshot's scan reads it (`createSourceScans`, held on the ctx). */
  sources: SourceScans;
  /**
   * What keeps a non-portable server barrel outside the graph: the modules
   * of its closure that need the computer, each with its chain
   * ({@link serverBarrelBlockers}). Never empty. Asked only to explain a
   * failure.
   */
  blockers(barrel: string): Promise<string[]>;
}

/** What a scoped page uses, all covered. */
export interface HostCoverage {
  /** Every live read the scope references, sorted by key. */
  reads: HostRead[];
}

/** The file set the scan reads (its blob ids key the file records). */
type ScanRepo = RepoFiles;

// ── Paths ─────────────────────────────────────────────────────────────────

const dotId = (plugin: string): string => plugin.split("/plugins/").join(".");

const BACKEND_FOLDERS = ["server", "machine", "central"] as const;

const SOURCE_RE = /\.tsx?$/;

const isSource = (path: string): boolean =>
  SOURCE_RE.test(path) && !isTestCodePath(path.split("/"));

/** Every non-test source file directly owned by `plugin`'s `folder/` (no child plugin). */
function folderFiles(repo: ScanRepo, plugin: string, folder: string): string[] {
  return repo.under(`plugins/${plugin}/${folder}`).filter(isSource);
}

/** Every non-test source file of `plugin` itself, in any folder (no child plugin). */
function pluginFiles(repo: ScanRepo, plugin: string): string[] {
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
  repo: ScanRepo,
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

/** What a module declares and imports, resolved against the file set. */
interface ModuleShape {
  /** Exported names re-exported from another module: name → (module, its name there). */
  reexports: Map<string, { from: string; name: string }>;
  /** `export * from …` targets. */
  stars: string[];
  /** Names declared in this file (`const` / `function` / `class` …). */
  locals: Set<string>;
  /** Imported value bindings: local → (module, exported name), with the import's line. */
  imports: Map<string, { from: string; name: string; line: number }>;
}

/**
 * One file of the snapshot: its facts — a file record
 * (`browser-host-coverage.scan.ts`), so an unchanged file is never read or
 * masked — and their reading against the file set (what its specifiers
 * resolve to), computed on first ask.
 */
class Module {
  #shape: ModuleShape | undefined;
  #descriptors: Map<string, DescriptorInfo[]> | undefined;
  #src: Promise<{ src: string; masked: string }> | undefined;

  constructor(
    private readonly repo: ScanRepo,
    readonly path: string,
    readonly facts: CoverageFacts,
  ) {}

  get reexports(): ModuleShape["reexports"] {
    return this.#parsed().reexports;
  }
  get stars(): string[] {
    return this.#parsed().stars;
  }
  get locals(): Set<string> {
    return this.#parsed().locals;
  }
  get imports(): ModuleShape["imports"] {
    return this.#parsed().imports;
  }
  /** Whether it imports `pageTransport` (talks to the page's own server). */
  get pageBound(): boolean {
    return this.facts.pageBound;
  }

  /** The descriptors it declares (the resource vocabulary's index of this one file). */
  get descriptors(): Map<string, DescriptorInfo[]> {
    return (this.#descriptors ??= new Map(this.facts.descriptors));
  }

  /** The endpoints it declares (`endpointExports`). */
  get endpoints(): EndpointExport[] {
    return this.facts.endpoints;
  }

  #parsed(): ModuleShape {
    return (this.#shape ??= resolveShape(this.repo, this.path, this.facts));
  }

  /**
   * Its calls of `name`: a register marker's from the facts; a serving
   * wrapper's (a name only the repo-wide fixpoint knows) read off the source,
   * for the few files that call one.
   */
  async callsOf(name: string): Promise<CallSite[]> {
    if (this.facts.markers.includes(name))
      return this.facts.calls.filter((c) => c.name === name);
    const { src, masked } = await this.#source();
    return findMarkerCalls(src, name, masked).map((call) => ({
      name,
      argsText: call.argsText,
      line: lineAt(src, call.index),
    }));
  }

  /** `parseFileBindings` of it: from the facts when it makes a register call. */
  async bindings(): Promise<FileBindings> {
    if (this.facts.calls.length > 0) return new Map(this.facts.bindings);
    const { src, masked } = await this.#source();
    return parseFileBindings(src, masked);
  }

  #source(): Promise<{ src: string; masked: string }> {
    return (this.#src ??= this.repo.read(this.path).then((src) => {
      if (src === null)
        throw new Error(`[browser-host] ${this.path} left the file set`);
      return { src, masked: maskSource(src) };
    }));
  }
}

function resolveShape(
  repo: ScanRepo,
  path: string,
  facts: CoverageFacts,
): ModuleShape {
  const locals = new Set(facts.locals);
  const reexports = new Map<string, { from: string; name: string }>();
  const stars: string[] = [];
  const imports = new Map<
    string,
    { from: string; name: string; line: number }
  >();
  for (const ref of facts.imports) {
    const target = resolveModule(repo, path, ref.specifier);
    if (ref.reexport) {
      if (target === null || ref.typeOnly) continue;
      if (ref.star) {
        stars.push(target);
        continue;
      }
      for (const item of ref.items) {
        if (!item.typeOnly)
          reexports.set(item.local, { from: target, name: item.imported });
      }
      continue;
    }
    if (target === null || ref.typeOnly) continue;
    for (const item of ref.items) {
      if (item.typeOnly) continue;
      imports.set(item.local, {
        from: target,
        name: item.imported,
        line: ref.line,
      });
    }
  }
  // `export { a as b }` with no `from`: a local (or imported) name, exported.
  for (const alias of facts.exportAliases) {
    const imported = imports.get(alias.imported);
    if (imported !== undefined) reexports.set(alias.local, imported);
    else locals.add(alias.local);
  }
  return { reexports, stars, locals, imports };
}

/**
 * The coverage scan's reading of one snapshot (a `RegistryGenContext`'s file
 * set): every file's facts read once — a file record, asked in batches —
 * and the repo-wide facts every
 * host's scan shares — the serving wrappers, each backend barrel's routes,
 * each plugin's descriptor index — derived at most once. Held on the ctx
 * (`RegistryGenContext.sourceScans`), so it has exactly the snapshot's
 * lifetime: never a module-level cache that would outlive the files it read.
 */
export class SourceScans {
  readonly #files = new Map<string, Promise<Module | null>>();
  readonly #routes = new Map<string, Promise<string[]>>();
  readonly #pluginIndexes = new Map<
    string,
    Promise<Map<string, DescriptorInfo[]>>
  >();
  #wrappers: Promise<Set<string>> | undefined;
  #allRoutes: Promise<void> | undefined;

  constructor(readonly repo: ScanRepo) {}

  /** One file, read once (null when the file set has no such file). */
  read(path: string): Promise<Module | null> {
    return this.readMany([path]).then(([m]) => m!);
  }

  /**
   * `paths`, each read once: the ones not read yet, as one batch of file
   * records (one store call, grouped by plugin) — so a caller reading many
   * files asks for them together.
   */
  readMany(paths: readonly string[]): Promise<(Module | null)[]> {
    const fresh = [...new Set(paths.filter((p) => !this.#files.has(p)))];
    if (fresh.length > 0) {
      const members = fresh.filter((p) => this.repo.has(p));
      const batch = scanRepoFiles(this.repo, members, coverageFactsScan).then(
        (facts) => new Map(members.map((p, i) => [p, facts[i]!])),
      );
      for (const p of fresh)
        this.#files.set(
          p,
          batch.then((byPath) => {
            const f = byPath.get(p);
            return f === undefined ? null : new Module(this.repo, p, f);
          }),
        );
    }
    return Promise.all(paths.map((p) => this.#files.get(p)!));
  }

  /** The file declaring `name` as `module` exports it, through re-exports. */
  async resolveExport(
    module: string,
    name: string,
    seen = new Set<string>(),
  ): Promise<{ module: Module; name: string } | null> {
    const key = `${module}#${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const m = await this.read(module);
    if (m === null) return null;
    const re = m.reexports.get(name);
    if (re !== undefined) return this.resolveExport(re.from, re.name, seen);
    if (m.locals.has(name)) return { module: m, name };
    for (const star of m.stars) {
      const hit = await this.resolveExport(star, name, seen);
      if (hit !== null) return hit;
    }
    return null;
  }

  /** Every serving wrapper of the repo's backend code (see `serveWrappers`). */
  wrappers(): Promise<Set<string>> {
    return (this.#wrappers ??= serveWrappers(this));
  }

  /** `barrel`'s `httpRoutes` (see `httpRoutes`) — a rejection is every asker's same failure. */
  routes(barrel: string): Promise<string[]> {
    let r = this.#routes.get(barrel);
    if (r === undefined) {
      r = httpRoutes(this, barrel);
      this.#routes.set(barrel, r);
    }
    return r;
  }

  /**
   * Every backend barrel's routes read, member or not: a route held where the
   * scan cannot read it is refused wherever it is (`httpRoutes` throws), not
   * only once it joins a graph.
   */
  readAllRoutes(): Promise<void> {
    return (this.#allRoutes ??= (async () => {
      const barrels = this.repo.under("plugins").filter((path) => {
        const where = locate(path);
        return (
          where !== null &&
          path === `plugins/${where.plugin}/${where.folder}/index.ts` &&
          (BACKEND_FOLDERS as readonly string[]).includes(where.folder)
        );
      });
      await Promise.all(barrels.map((path) => this.routes(path)));
    })());
  }

  /** The descriptor index of every non-test file of `plugin` (`a/plugins/b`), merged in file order. */
  pluginIndex(plugin: string): Promise<Map<string, DescriptorInfo[]>> {
    let index = this.#pluginIndexes.get(plugin);
    if (index === undefined) {
      index = (async () => {
        const merged = new Map<string, DescriptorInfo[]>();
        const files = await this.readMany(pluginFiles(this.repo, plugin));
        for (const m of files) {
          if (m === null) continue;
          for (const [name, infos] of m.descriptors) merged.set(name, infos);
        }
        return merged;
      })();
      this.#pluginIndexes.set(plugin, index);
    }
    return index;
  }
}

/** A fresh scan of `repo` — hold one per snapshot (`RegistryGenContext.sourceScans`). */
export function createSourceScans(repo: ScanRepo): SourceScans {
  return new SourceScans(repo);
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
  const { sources, label } = inputs;
  const { repo } = sources;
  const read = (path: string) => sources.read(path);
  const resolveExport = (module: string, name: string) =>
    sources.resolveExport(module, name);
  const members = new Set(inputs.members);

  const declarationIn = (m: Module, name: string): Declaration | null => {
    const infos = m.descriptors.get(name);
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
    const endpoint = m.endpoints.find((e) => e.name === name);
    if (endpoint !== undefined) {
      return { kind: "endpoint", file: m.path, name, endpoint };
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

  // The scoped plugins' own files, read at once; the helpers they lead to are
  // read as they are found.
  await sources.readMany(readers);
  const mixed: Reader[] = [];
  for (let i = 0; i < readers.length; i++) {
    const m = await read(readers[i]!);
    if (m === null) continue;
    // A page-bound module's endpoints are the page's (see the header); a
    // scope fetcher beside them is refused, not skipped.
    if (m.pageBound && m.facts.scopeFetcherLine !== null) {
      mixed.push({ file: m.path, line: m.facts.scopeFetcherLine });
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
      if (!Object.hasOwn(m.facts.secondUseLines, name)) continue;
      const line = m.facts.secondUseLines[name]!;
      note(decl, { file: m.path, line });
    }
    // A raw `/api/<prefix>` URL the file builds by hand: a string literal
    // that STARTS with it (a route string `"GET /api/…"` or prose naming one
    // is not a URL). A page-bound module's is the page's.
    if (!m.pageBound) {
      for (const hit of m.facts.rawApi) {
        const list = rawApi.get(hit.prefix) ?? [];
        list.push({ file: m.path, line: hit.line });
        rawApi.set(hit.prefix, list);
      }
    }
  }

  // ── What the graph serves ──
  const wrappers = await sources.wrappers();
  const servedKeys = new Set<string>();
  // Every host mounts its resource runtime's own HTTP read (server-core's host
  // routes), whatever its graph.
  const servedRoutes = new Set<string>([RESOURCE_HTTP_ROUTE]);
  for (const plugin of members) {
    for (const key of await registeredKeys(
      sources,
      wrappers,
      plugin,
      folderFiles(repo, plugin, "server"),
    ))
      servedKeys.add(key);
    for (const route of await sources.routes(
      `plugins/${plugin}/server/index.ts`,
    ))
      servedRoutes.add(route);
  }
  // Every backend barrel's routes are read, member or not, though only a
  // member's serve the host — once per snapshot (see `readAllRoutes`); an
  // explanation naming who serves a prefix is then complete.
  await sources.readAllRoutes();

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
    servers ??= indexServers(sources, wrappers);
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

  // Besides what the graph serves, central's resource read
  // (`CENTRAL_RESOURCE_HTTP_ROUTE`): the live-state client builds its URL for a
  // central read, which the read arm above already requires `needsMachine` —
  // so on a browser host it is never asked.
  const servedPrefixes = new Set(
    [...servedRoutes, CENTRAL_RESOURCE_HTTP_ROUTE].map(routePrefix),
  );
  // The resource runtime's own reads, which the live-state client builds and
  // sends through the subtree's transport — the one hand-built URL a scope's
  // code holds that never reaches an element.
  const runtimePrefixes = new Set(
    [RESOURCE_HTTP_ROUTE, CENTRAL_RESOURCE_HTTP_ROUTE].map(routePrefix),
  );
  for (const [prefix, at] of [...rawApi].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (runtimePrefixes.has(prefix)) continue;
    const where = at
      .slice(0, 3)
      .map((r) => `${r.file}:${r.line}`)
      .join(", ");
    // Served is not enough: a fetch of it is already refused (the
    // `no-raw-web-fetch` lint, the page request guard), so a hand-built URL in
    // scoped code is one an element, a popup or a library loads by itself —
    // from the PAGE's server, never the host's worker (the Sonata covers).
    if (servedPrefixes.has(prefix)) {
      problems.push(
        `a raw "/api/${prefix}" URL is built by hand in scoped code: whatever loads it by URL (an element, a popup, a library) reaches the page's server, not the host — build an \`AssetPath\` from the endpoint serving it (\`assetPath\` + \`useAssetSrc\` / \`assetUrlOver\`)\n      named at ${where}${at.length > 3 ? ` (+${at.length - 3} more)` : ""}`,
      );
      continue;
    }
    // Every route is read (`httpRoutes` throws on a key it cannot), so a
    // prefix no member serves is unserved — whether another barrel serves it
    // or none does.
    problems.push(
      `a raw "/api/${prefix}" URL is not served by the graph (a URL built by hand cannot declare \`needsMachine\` — call the endpoint through \`useFetchEndpoint\`, or build an \`AssetPath\` from it): ${await explain({ prefix })}\n      named at ${where}${at.length > 3 ? ` (+${at.length - 3} more)` : ""}`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `${label}: ${problems.length} declaration(s) the scoped page uses have no answer on the host — each must be served by a graph member's \`server/\` (make the serving barrel portable by moving what needs the computer out of its closure into \`machine/\`, or split what it serves into a portable \`server/\` half) or declare \`needsMachine\`:\n  - ${problems.join("\n  - ")}`,
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

/**
 * The keys `plugin`'s `files` serve: every register call's descriptor, resolved
 * through the plugin's own declarations and, for an imported descriptor, the
 * declaring plugin's — the docs facet's reading (`registerCallTarget`). A call
 * to a serving WRAPPER (`serveTranscriptValue(value, derive)`: a function
 * handing its first parameter to a register call) counts as a register call.
 */
async function registeredKeys(
  sources: SourceScans,
  wrappers: ReadonlySet<string>,
  plugin: string,
  files: readonly string[],
): Promise<string[]> {
  const keys: string[] = [];
  for (const m of await sources.readMany(files)) {
    if (m === null) continue;
    const markers = [
      ...m.facts.markers,
      ...(await wrappersCalledIn(sources, m, wrappers)),
    ];
    if (markers.length === 0) continue;
    const own = await sources.pluginIndex(plugin);
    const bindings = await m.bindings();
    // Imported descriptors resolve through the declaring plugin's index,
    // prepared before the (synchronous) scan asks for it.
    const imported = new Map<string, Map<string, DescriptorInfo[]>>();
    for (const b of bindings.values()) {
      if (b.specifier?.startsWith("@plugins/") === true && !b.typeOnly) {
        const dir = b.specifier
          .replace(/^@plugins\//, "")
          .replace(/\/[^/]+$/, "");
        imported.set(b.specifier, await sources.pluginIndex(dir));
      }
    }
    const resolveImported: ImportedDescriptorResolver = (specifier, name) =>
      imported.get(specifier)?.get(name) ?? null;
    for (const marker of markers) {
      for (const call of await m.callsOf(marker)) {
        const target = registerCallTarget(
          marker,
          call.argsText,
          bindings,
          own,
          { file: m.path, line: call.line },
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
async function serveWrappers(sources: SourceScans): Promise<Set<string>> {
  const paths = sources.repo.under("plugins").filter((path) => {
    const where = locate(path);
    return (
      where !== null &&
      isSource(path) &&
      (BACKEND_FOLDERS as readonly string[]).includes(where.folder)
    );
  });
  // Only a module with a function handing its parameter on can serve, and
  // only one that re-exports can alias a wrapper: no other is looked at.
  const candidates = (await sources.readMany(paths)).filter(
    (m): m is Module =>
      m !== null &&
      (m.facts.functions.length > 0 ||
        m.facts.exportAliases.length > 0 ||
        m.facts.imports.some((i) => i.reexport)),
  );
  const wrappers = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    const names = wrapperNames(wrappers);
    for (const m of candidates) {
      // The names this module may call to serve: the markers, and the
      // wrappers it imports or declares.
      const markers = [
        ...m.facts.markers,
        ...(await wrappersCalledIn(sources, m, wrappers)),
      ];
      // A wrapper re-exported under another name is named by that one in
      // its importers' text: record the alias, so their filter sees it.
      for (const [alias, re] of m.reexports) {
        const id = `${m.path}#${alias}`;
        if (wrappers.has(id) || !names.has(re.name)) continue;
        const hit = await sources.resolveExport(re.from, re.name);
        if (hit !== null && wrappers.has(`${hit.module.path}#${hit.name}`)) {
          wrappers.add(id);
          grew = true;
        }
      }
      if (markers.length === 0) continue;
      for (const fn of m.facts.functions) {
        const id = `${m.path}#${fn.name}`;
        if (wrappers.has(id)) continue;
        if (!fn.servedBy.some((name) => markers.includes(name))) continue;
        wrappers.add(id);
        grew = true;
      }
    }
  }
  return wrappers;
}

/**
 * Every name a serving wrapper goes by: its declared name, or an alias it is
 * re-exported under (`serveWrappers` records both, as `<module>#<name>`). A
 * file naming none of them cannot import or call one.
 */
function wrapperNames(wrappers: ReadonlySet<string>): Set<string> {
  return new Set([...wrappers].map((id) => id.slice(id.lastIndexOf("#") + 1)));
}

/**
 * The local names under which `m` calls a serving wrapper: an import resolving
 * to one (only an import of a name some wrapper goes by is resolved), or one
 * it declares.
 */
async function wrappersCalledIn(
  sources: SourceScans,
  m: Module,
  wrappers: ReadonlySet<string>,
): Promise<string[]> {
  if (wrappers.size === 0) return [];
  const names = wrapperNames(wrappers);
  const out: string[] = [];
  for (const [local, imp] of m.imports) {
    if (!names.has(imp.name)) continue;
    const hit = await sources.resolveExport(imp.from, imp.name);
    if (hit !== null && wrappers.has(`${hit.module.path}#${hit.name}`))
      out.push(local);
  }
  for (const name of m.locals) {
    if (wrappers.has(`${m.path}#${name}`)) out.push(name);
  }
  return out;
}

/**
 * The HTTP routes a backend barrel's `httpRoutes` serves: a literal
 * `"METHOD /path"` key, or a computed `[endpoint.route]` resolved to the
 * endpoint's declaration (a `defineEndpoint` with a literal `route:`).
 *
 * STRICT: every key must be one of those two. Any other key — a constant
 * (`[ROUTE_KEY]`), a template with a substitution, a spread, a shorthand — is
 * a route this scan cannot read, so it THROWS naming the barrel and the key
 * rather than drop it: a dropped route is one the guard would call unserved
 * (or, worse, a raw URL to it would look judged). So is an `httpRoutes` that
 * is not an object literal, and a `[x.route]` that names no endpoint. (The
 * keys are read with the file's facts, `routesOf` in the scan.)
 */
async function httpRoutes(
  sources: SourceScans,
  barrel: string,
): Promise<string[]> {
  const m = await sources.read(barrel);
  if (m === null) return [];
  const facts = m.facts.routes;
  if (facts.kind === "none") return [];
  if (facts.kind === "error") throw new Error(facts.message);
  const routes: string[] = [];
  for (const entry of facts.entries) {
    if (entry.kind === "error") throw new Error(entry.message);
    if (entry.kind === "literal") {
      routes.push(entry.route);
      continue;
    }
    const { local, keyText } = entry;
    const imp = m.imports.get(local);
    const hit =
      imp !== undefined
        ? await sources.resolveExport(imp.from, imp.name)
        : m.locals.has(local)
          ? { module: m, name: local }
          : null;
    const e =
      hit === null
        ? undefined
        : hit.module.endpoints.find((x) => x.name === hit.name);
    if (e === undefined) {
      throw new Error(
        unreadableRoute(
          barrel,
          keyText,
          `names no endpoint declaration (\`${local}\` does not resolve to a \`defineEndpoint\` with a literal \`route:\`)`,
        ),
      );
    }
    routes.push(e.route);
  }
  return routes;
}
// ── Explaining a gap ──────────────────────────────────────────────────────

/**
 * What keeps the non-portable server `barrel` out of a browser host: the
 * modules of its static closure that need the computer (the platform APIs
 * they import, the host-only values they use, the host services no portable
 * `server/` barrel provides), each with its import chain — the frontier
 * `serverPortabilityOf`'s `offenders` names. Never empty: a barrel with
 * nothing to name is portable, and `offenders` throws for it.
 */
export function serverBarrelBlockers(
  portability: Pick<ServerPortability, "offenders">,
  barrel: string,
): string[] {
  return portability
    .offenders(barrel)
    .map(
      (o) =>
        `${o.module} needs ${o.needs.join(", ")} (via ${o.chain.join(" → ")})`,
    );
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
  sources: SourceScans,
  wrappers: ReadonlySet<string>,
): Promise<ServerIndex> {
  const { repo } = sources;
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
        sources,
        wrappers,
        plugin,
        files,
      )) {
        add(keys, key, site);
      }
      for (const route of await sources.routes(barrel)) {
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
  return `served by ${where}, which is not portable: ${blockers.slice(0, 4).join("; ")}${blockers.length > 4 ? ` (+${blockers.length - 4} more)` : ""}`;
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
    readonly (Pick<ServerContributionKindDecl, "kind" | "absentOnHost"> & {
      plugin: string;
    })[]
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
    const why = `it is not portable: ${blockers.slice(0, 4).join("; ")}${blockers.length > 4 ? ` (+${blockers.length - 4} more)` : ""}`;
    problems.push(
      `${inputs.label}: ${b.plugin}/server contributes to kinds a graph member reads, but the host does not boot it — ${why}\n      ${gaps.join("\n      ")}`,
    );
  }
  return problems;
}
