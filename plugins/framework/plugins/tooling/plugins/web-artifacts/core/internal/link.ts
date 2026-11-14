// The link: the page's per-plugin artifacts → route chunks.
//
// Every page artifact keeps one emitted file per source module
// (`vite-builder.ts`, `preserveModules`), and still imports other plugins by
// their barrel specifier (`@plugins/<p>/web`) — its bytes, and so its address,
// know nothing of another plugin's files. The link is where the composed
// fleet is read together, once per build:
//
// 1. **Elision.** A named import of a barrel (`import { cn } from
//    "@plugins/…/ui-kit/web"`) is rewritten to import from the module that
//    DEFINES the name, following the target's re-export hops (the lexer
//    resolves `export { a as b } from` and import-then-export alike). So an
//    import loads that module and what it needs — never the barrel's other
//    re-exports. The registry's `import("@plugins/<p>/web")` reads only
//    `.default` (`web-sdk`'s `loadPlugins`), so it is pointed at the barrel's
//    plugin definition (`__plugin.js`, `plugin-definition.ts`). A namespace
//    import, an `export *` target or any other dynamic import keeps the whole
//    barrel.
// 2. **Membership** over the elided graph: `boot` is the static closure of the
//    entry, the registry and the eager plugins' definitions; each app root's
//    set is the closure of its deferred plugins' definitions outside boot (the
//    boot's priority batch, `apps-core/app-preload`).
// 3. **Bundling** with rolldown: boot and each app set are code-splitting
//    groups split by size (a few files a route on the six-socket HTTP/1.1
//    gateway — research/2026-11-12-global-load-model-redesign.md §12.5);
//    lazily loaded code keeps rolldown's own chunking. Vendors and the browser
//    host modules stay external (the import map serves them).
// 4. **Publishing**: each chunk is a store entry `chunk.<hash>` (its URL is its
//    content, so an unchanged chunk keeps its URL across builds), the result
//    a `link.<key>` record keyed by every input address — a tree whose page
//    artifacts did not change reuses it without bundling.
//
// Semantics, deliberately: a module only re-exported by a barrel is evaluated
// only once something imports a binding from it. Side-effect imports in a
// barrel stay in its definition module, so what registers that way still
// does. Plan: research/2026-11-14-global-load-redesign-r1-module-imports-route-chunks.md.

import { writeFileSync } from "node:fs";
import { posix } from "node:path";
import {
  existsSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import type { OutputChunk } from "rolldown";
import {
  init as lexerInit,
  parse as lexerParse,
  type Export,
} from "es-module-lexer";
import {
  BROWSER_HOST_SNAPSHOT_SPECIFIER_PREFIX,
  BROWSER_HOST_SPECIFIER_PREFIX,
  BROWSER_HOST_WORKER_SPECIFIER_PREFIX,
  isImportMapOnlySpecifier,
  PAGE_SCRIPT_MODULES,
} from "@plugins/framework/plugins/import-map-names/core";
import { appRootOf } from "@plugins/apps-core/plugins/app-preload/core";
import { sha256Hex } from "../hash";
import { isBrowserUnreachableDynamic, WORKER_ONLY_KINDS } from "../constants";
import { COMPOSITION_REGISTRY_SPECIFIER } from "../composition-modules";
import {
  parseStatementBindings,
  renderStatement,
  type Binding,
} from "./bindings";
import { PLUGIN_DEFINITION_ENTRY } from "./plugin-definition";
import { coEntryFileName, type CoEntry } from "./vite-builder";
import {
  artifactStorePath,
  artifactTmpDir,
  hasArtifact,
  publishArtifact,
  publishDir,
  readArtifactMeta,
  touchArtifact,
  type ArtifactMeta,
} from "./store";

/** Bump to re-link every tree (hash input of the link key). */
const LINK_VERSION = 1;

/**
 * The largest boot / app chunk rolldown aims for, in raw bytes. ~100 KB br:
 * the website's boot set is ~10 files, main's ~30 — against 600 and 1,600
 * per-plugin files, the local gateway's six sockets stay busy without queueing
 * hundreds of requests behind each other.
 */
const ROUTE_CHUNK_MAX_BYTES = 400_000;

/** The store-entry prefix of a route chunk; its file is always `index.js`. */
export const CHUNK_PREFIX = "chunk.";
/** The store-entry prefix of a link record. */
export const LINK_PREFIX = "link.";
/** The record of the link a dist was composed from, beside `index.html`. */
export const DIST_LINK_FILE = ".web-link.json";

/** One page artifact as the link reads it. */
export interface LinkArtifact {
  dirName: string;
  /** The import-map specifier its barrel serves (`@plugins/<p>/<folder>`). */
  specifier: string | null;
  kind: string;
  pluginPath: string | null;
  coEntries: readonly CoEntry[];
}

export interface LinkInputs {
  /** The builder identity: the link's code is part of it (`core/`). */
  identityHash: string;
  minify: boolean;
  entryDirName: string;
  registryDirName: string;
  /** Every page artifact but the entry and the registry. */
  artifacts: readonly LinkArtifact[];
  /** Specifiers the page resolves through its import map (vendors, hosts). */
  isExternal: (specifier: string) => boolean;
  vendorSetHash: string;
  /** Web plugins loaded at boot (not deferred). */
  eager: ReadonlySet<string>;
  /** Deferred web plugins under an app root, by root (`appRootOf`). */
  appPlugins: Readonly<Record<string, readonly string[]>>;
  /**
   * Barrels a page script outside the bundle imports by specifier
   * (`PAGE_SCRIPT_MODULES`): each its own entry chunk, mapped by the page.
   */
  pageScripts: readonly string[];
}

/** What a link produced — published as the `link.<key>` record's meta. */
export interface LinkRecord {
  v: typeof LINK_VERSION;
  key: string;
  /** The entry chunk's URL: the page's `<script type="module">`. */
  entryUrl: string;
  /** Every chunk store entry (`chunk.<hash>`), sorted. */
  chunks: string[];
  /** Chunk URLs the boot's modulepreload closure starts from. */
  bootSeeds: string[];
  /** Per app root: the chunk URLs of its deferred plugins' definitions. */
  appSeeds: Record<string, string[]>;
  /** Each page-script specifier's entry chunk URL (an import-map entry). */
  pageScripts: Record<string, string>;
  /**
   * Artifact dirs a chunk addresses files of (images, worker bundles, by
   * `new URL("/artifacts/<dir>/…", import.meta.url)`): linked into the dist
   * for those files, never as modules.
   */
  assetDirs: string[];
  stats: {
    modules: number;
    bootModules: number;
    bootChunks: number;
    elidedImports: number;
  };
}

/**
 * The record's `modules.json`: every module the link bundled (by its path in
 * the store) → its group (`boot`, the `+`-joined app roots reaching it, or
 * `lazy`) and its chunk URL (null when tree-shaken away). What answers "why
 * is this module on that route".
 */
export const LINK_MODULES_FILE = "modules.json";
export type LinkModules = Record<
  string,
  { group: string; chunk: string | null }
>;

/** The link record's store entry name. */
export function linkDirName(key: string): string {
  return `${LINK_PREFIX}${key.slice(0, 16)}`;
}

/**
 * The link's key: every input that can change its output — the addresses of
 * the artifacts it reads (content), the vendor set (what is external), the
 * tier split (the groups) and the builder identity (this code).
 */
export function linkKey(inputs: LinkInputs): string {
  const lines = [
    `v\t${LINK_VERSION}`,
    `identity\t${inputs.identityHash}`,
    `minify\t${inputs.minify}`,
    `entry\t${inputs.entryDirName}`,
    `registry\t${inputs.registryDirName}`,
    `vendors\t${inputs.vendorSetHash}`,
    ...inputs.artifacts.map((a) => `artifact\t${a.dirName}`).sort(),
    ...[...inputs.eager].map((p) => `eager\t${p}`).sort(),
    ...Object.entries(inputs.appPlugins)
      .flatMap(([root, paths]) => paths.map((p) => `app\t${root}\t${p}`))
      .sort(),
    ...[...inputs.pageScripts].map((s) => `page-script\t${s}`).sort(),
    // What stays external besides the vendor set (`framework/import-map-names`).
    ...[
      BROWSER_HOST_SPECIFIER_PREFIX,
      BROWSER_HOST_WORKER_SPECIFIER_PREFIX,
      BROWSER_HOST_SNAPSHOT_SPECIFIER_PREFIX,
    ].map((p) => `external-prefix\t${p}`),
  ];
  return sha256Hex(lines.join("\n") + "\n");
}

/**
 * The link inputs of a planned fleet — one derivation for the pipeline and
 * the map-in-sync check (`expected.ts`), so the key they compute cannot drift.
 */
export function linkInputsOf(opts: {
  identityHash: string;
  minify: boolean;
  /** Page targets: the web artifacts and the barrel closure they reach. */
  pageTargets: readonly LinkArtifact[];
  entryDirName: string;
  registryDirName: string;
  /** The vendor set: its specifiers are external, served by the import map. */
  vendorSet: { setHash: string; entries: Readonly<Record<string, string>> };
  deferredPaths: ReadonlySet<string>;
}): LinkInputs {
  const vendorSpecs = new Set(Object.keys(opts.vendorSet.entries));
  const eager = new Set<string>();
  const appPlugins: Record<string, string[]> = {};
  for (const t of opts.pageTargets) {
    if (t.kind !== "web" || t.pluginPath === null) continue;
    if (!opts.deferredPaths.has(t.pluginPath)) {
      eager.add(t.pluginPath);
      continue;
    }
    const root = appRootOf(t.pluginPath);
    if (root !== null) (appPlugins[root] ??= []).push(t.pluginPath);
  }
  for (const paths of Object.values(appPlugins)) paths.sort();
  const served = new Set(opts.pageTargets.map((t) => t.specifier));
  return {
    identityHash: opts.identityHash,
    minify: opts.minify,
    entryDirName: opts.entryDirName,
    registryDirName: opts.registryDirName,
    artifacts: opts.pageTargets.filter(
      (t) => !WORKER_ONLY_KINDS.has(t.kind) && t.dirName !== opts.entryDirName,
    ),
    isExternal: (spec) =>
      vendorSpecs.has(spec) || isImportMapOnlySpecifier(spec),
    vendorSetHash: opts.vendorSet.setHash,
    eager,
    appPlugins,
    pageScripts: Object.values(PAGE_SCRIPT_MODULES).filter((spec) =>
      served.has(spec),
    ),
  };
}

/** The served URL of a file inside a store entry. */
function urlOf(dirName: string, rel: string): string {
  return `/artifacts/${dirName}/${rel}`;
}

/** Read a stored record; null when absent or when any chunk it names is gone. */
function readLinkRecord(dirName: string): LinkRecord | null {
  if (!existsSync(joinAppPath(artifactStorePath(dirName), "meta.json")))
    return null;
  const record = JSON.parse(
    readFileSync(joinAppPath(artifactStorePath(dirName), "meta.json"), "utf8"),
  ) as LinkRecord;
  if (record.v !== LINK_VERSION) return null;
  return record;
}

/**
 * The link of `inputs`: reused from the store when its record and every chunk
 * it names are there, else bundled and published. Every entry is pinned
 * (`pin`) before it is read or published (`lease.ts`).
 */
export async function ensureLink(
  inputs: LinkInputs & {
    pin: (paths: AppPath[]) => Promise<void>;
    log: (line: string) => void;
  },
): Promise<{
  record: LinkRecord;
  chunkMetas: Map<string, ArtifactMeta>;
  cached: boolean;
}> {
  const key = linkKey(inputs);
  const recordDir = linkDirName(key);
  await inputs.pin([artifactStorePath(recordDir)]);
  const stored = readLinkRecord(recordDir);
  if (stored !== null) {
    await inputs.pin(stored.chunks.map(artifactStorePath));
    if (stored.chunks.every(hasArtifact)) {
      for (const c of stored.chunks) touchArtifact(c);
      touchArtifact(recordDir);
      return {
        record: stored,
        chunkMetas: new Map(stored.chunks.map((c) => [c, readArtifactMeta(c)])),
        cached: true,
      };
    }
    // A pruned chunk: bundle again — the chunks are republished, the record
    // (write-once, maybe pinned by another build) stays as it is.
  }
  const { record, chunkMetas, modules } = await runLink({ ...inputs, key });
  const tmp = artifactTmpDir(recordDir);
  writeFileSync(
    joinAppPath(tmp, LINK_MODULES_FILE),
    JSON.stringify(modules, null, 1),
  );
  await publishDir({
    tmpDir: tmp,
    dest: artifactStorePath(recordDir),
    meta: record,
    isComplete: () => readLinkRecord(recordDir) !== null,
  });
  return { record, chunkMetas, cached: false };
}

// ── The module graph ──────────────────────────────────────────────────

interface ModuleSource {
  code: string;
  imports: ReturnType<typeof lexerParse>[0];
  exports: ReadonlyArray<Export>;
}

export interface LinkedModule {
  /** The rewritten code rolldown bundles. */
  code: string;
  map: string | null;
  /** Static first-party dependencies (absolute files). */
  statics: string[];
  /** Dynamic first-party dependencies (absolute files). */
  dynamics: string[];
}

/** Where a name a module exports is defined. */
interface Defined {
  file: string;
  name: string;
}

/** A boot-preloaded descriptor's flag, as an emitted module spells it. */
const BOOT_PRELOAD = /\bpreload:\s*["'`]boot/;

const SOURCEMAP_COMMENT = /\n?\/\/# sourceMappingURL=[^\n]*\s*$/;

/** Where the link reads the page artifacts' files: the store, or a test's. */
export interface LinkIo {
  /** The directory a store entry's files are in. */
  storePath: (dirName: string) => string;
  /** A file's text, or null when there is none. */
  read: (file: string) => string | null;
}

/** The artifact store's own files (every module is a file of a store entry: app-owned). */
const storeIo: LinkIo = {
  storePath: artifactStorePath,
  read: (file) => {
    const path = asAppPath(file);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  },
};

/** The elided module graph and where each module belongs (`runLink`'s first half). */
export interface LinkGraph {
  entryFile: string;
  registryFile: string;
  pageScriptFiles: string[];
  /** Every module the page reaches, rewritten, by its id (its file). */
  linked: Map<string, LinkedModule>;
  /** The boot set: the static closure of {@link bootRoots}. */
  boot: Set<string>;
  bootRoots: string[];
  /** Modules evaluated for the descriptors they register (imported by the registry). */
  bootRegistering: string[];
  /** The artifacts the boot evaluated under barrel semantics. */
  barrelBoot: Set<string>;
  /** App root → its deferred plugins' definition modules. */
  appRoots: Map<string, string[]>;
  /** Module outside boot → the `+`-joined app roots reaching it. */
  appGroupOf: Map<string, string>;
  appGroupKeys: string[];
  assetDirs: Set<string>;
  elided: number;
}

/**
 * Elide, walk and assign: every module the page reaches, its imports
 * rewritten to the modules defining what they name, and the boot / app-set
 * membership the chunks are grouped by. Pure over `io`.
 */
export async function planLinkGraph(
  inputs: LinkInputs,
  io: LinkIo = storeIo,
): Promise<LinkGraph> {
  await lexerInit();

  // Specifier → the file it names, and every artifact's dir by its store path.
  const bySpecifier = new Map<string, string>();
  const definitionOf = new Map<string, string>(); // web barrel specifier → __plugin.js
  const dirOfStorePath = new Map<string, string>(); // store path → dirName
  const pluginOfDefinition = new Map<string, string>(); // __plugin.js → pluginPath
  for (const a of inputs.artifacts) {
    const dir = io.storePath(a.dirName);
    dirOfStorePath.set(dir, a.dirName);
    if (a.specifier !== null) bySpecifier.set(a.specifier, `${dir}/index.js`);
    for (const e of a.coEntries)
      bySpecifier.set(e.specifier, `${dir}/${coEntryFileName(e)}`);
    if (a.kind === "web" && a.specifier !== null && a.pluginPath !== null) {
      const def = `${dir}/${PLUGIN_DEFINITION_ENTRY}.js`;
      definitionOf.set(a.specifier, def);
      pluginOfDefinition.set(def, a.pluginPath);
    }
  }
  const entryFile = `${io.storePath(inputs.entryDirName)}/index.js`;
  const registryFile = `${io.storePath(inputs.registryDirName)}/index.js`;
  dirOfStorePath.set(io.storePath(inputs.entryDirName), inputs.entryDirName);
  dirOfStorePath.set(
    io.storePath(inputs.registryDirName),
    inputs.registryDirName,
  );
  bySpecifier.set(COMPOSITION_REGISTRY_SPECIFIER, registryFile);

  /** The store dir (and its dirName) a module file lives in. */
  const storeDirOf = (file: string): { dir: string; dirName: string } => {
    for (
      let d = posix.dirname(file);
      d !== "/" && d !== ".";
      d = posix.dirname(d)
    ) {
      const dirName = dirOfStorePath.get(d);
      if (dirName !== undefined) return { dir: d, dirName };
    }
    throw new Error(`link: ${file} is in no page artifact`);
  };

  const sources = new Map<string, ModuleSource>();
  const sourceOf = (file: string): ModuleSource => {
    let s = sources.get(file);
    if (s === undefined) {
      const raw = io.read(file);
      if (raw === null) throw new Error(`link: no module ${file}`);
      const code = raw.replace(SOURCEMAP_COMMENT, "\n");
      const [imports, exports] = lexerParse(code, file);
      s = { code, imports, exports };
      sources.set(file, s);
    }
    return s;
  };

  /** The file a first-party specifier names from `importer`, or null when external. */
  const resolveSpecifier = (importer: string, spec: string): string | null => {
    // An emitted module's relative import names a file of its own artifact
    // (or, in a chunk, another chunk), resolved as the browser does: by URL.
    if (spec.startsWith("./") || spec.startsWith("../"))
      return new URL(spec, `file://${importer}`).pathname;
    if (spec.startsWith("/")) return spec;
    const file = bySpecifier.get(spec);
    if (file !== undefined) return file;
    if (inputs.isExternal(spec)) return null;
    throw new Error(
      `link: ${importer} imports "${spec}", which no page artifact serves and the import map does not name`,
    );
  };

  /**
   * Where `name`, as `file` exports it, is defined: follows re-export hops to
   * the module declaring it. null when `file` does not list it (an `export *`
   * target's name, or none at all): the caller keeps the import as it is.
   */
  const defined = (file: string, name: string, depth = 0): Defined | null => {
    if (depth > 64)
      throw new Error(`link: re-export cycle through ${file} for "${name}"`);
    const src = sourceOf(file);
    for (const e of src.exports) {
      if (e.type === "direct" && e.name === name) return { file, name };
      if (e.type === "reexport" && e.name === name) {
        if (e.importName === null) return { file, name }; // `export * as ns`
        const target = resolveSpecifier(file, e.from);
        if (target === null) return { file, name };
        return (
          defined(target, e.importName, depth + 1) ?? {
            file: target,
            name: e.importName,
          }
        );
      }
    }
    for (const e of src.exports) {
      if (e.type !== "reexport-all") continue;
      const target = resolveSpecifier(file, e.from);
      if (target === null) continue;
      const found = defined(target, name, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };

  // Rewrite one module: elide named imports to their defining modules, point
  // first-party specifiers at absolute files (rolldown's ids), and served
  // file URLs at their absolute `/artifacts/` path.
  const assetDirs = new Set<string>();
  let elided = 0;
  const linkModule = (file: string): LinkedModule => {
    const src = sourceOf(file);
    const isRegistry = file === registryFile;
    const statics: string[] = [];
    const dynamics: string[] = [];
    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const imp of src.imports) {
      if (imp.type === "import-meta") continue;
      if (imp.type === "dynamic") {
        if (imp.specifier === undefined) {
          throw new Error(
            `link: ${file} has a dynamic import() of a computed specifier — the link cannot ` +
              `resolve it, and no import map would either (only vendors and hosts are mapped)`,
          );
        }
        const spec = imp.specifier;
        // A leaf folder's loader (a collected-dir registry run Bun-side): the
        // browser never invokes it, and nothing serves it — left as written.
        if (isBrowserUnreachableDynamic(spec)) continue;
        const target =
          isRegistry && definitionOf.has(spec)
            ? definitionOf.get(spec)!
            : resolveSpecifier(file, spec);
        if (target === null) continue;
        dynamics.push(target);
        edits.push({
          start: imp.start,
          end: imp.end,
          text: JSON.stringify(target),
        });
        continue;
      }
      const spec = imp.specifier;
      const target = resolveSpecifier(file, spec);
      if (target === null) continue;
      const bindings =
        imp.type === "reexport-star"
          ? null
          : parseStatementBindings(src.code.slice(imp.importStart, imp.start));
      if (
        bindings === null ||
        bindings.opaque ||
        bindings.namespace !== null ||
        bindings.star ||
        bindings.sideEffectOnly ||
        bindings.named.length === 0
      ) {
        statics.push(target);
        edits.push({ start: imp.start, end: imp.end, text: target });
        continue;
      }
      // Group the bindings by the module defining each.
      const groups = new Map<string, Binding[]>();
      for (const b of bindings.named) {
        const d = defined(target, b.imported) ?? {
          file: target,
          name: b.imported,
        };
        const list = groups.get(d.file) ?? [];
        list.push({ imported: d.name, local: b.local });
        groups.set(d.file, list);
      }
      if (groups.size === 1 && groups.has(target)) {
        statics.push(target);
        edits.push({ start: imp.start, end: imp.end, text: target });
        continue;
      }
      elided++;
      const text = [...groups]
        .map(([defFile, list]) => {
          statics.push(defFile);
          return renderStatement({
            reexport: bindings.reexport,
            bindings: list,
            specifier: defFile,
          });
        })
        .join("");
      edits.push({ start: imp.importStart, end: imp.importEnd, text });
    }
    let code = applyEdits(src.code, edits);
    if (isRegistry) {
      // The boot-registering modules, evaluated with the registry.
      code =
        bootRegistering.map((f) => `import ${JSON.stringify(f)};`).join("") +
        code;
      statics.push(...bootRegistering);
    }
    // A file beside the module (an image, a worker bundle): its served URL.
    if (code.includes("import.meta")) {
      const { dir, dirName } = storeDirOf(file);
      const relDir = posix.relative(dir, posix.dirname(file));
      code = code.replace(
        /new URL\(\s*(["'])([^"'`]+)\1\s*,\s*import\.meta\.url\s*\)/g,
        (_m, _q: string, rel: string) => {
          if (/^[a-z]+:/i.test(rel) || rel.startsWith("/")) return _m;
          const inDir = posix.normalize(posix.join(relDir, rel));
          if (inDir.startsWith("..")) {
            throw new Error(
              `link: ${file} addresses ${rel}, outside its artifact`,
            );
          }
          assetDirs.add(dirName);
          return `new URL(${JSON.stringify(urlOf(dirName, inDir))},import.meta.url)`;
        },
      );
      // Vite spells a worker's URL `new URL(new URL("<rel>",
      // import.meta.url).href, "" + import.meta.url)`: once the inner URL is
      // absolute, the outer base changes nothing.
      code = code.replace(
        /new URL\(\s*(?:\/\*[^*]*\*\/\s*)?(new URL\("\/artifacts\/[^"]+",import\.meta\.url\))\.href\s*,\s*""\s*\+\s*import\.meta\.url\s*\)/g,
        "$1",
      );
      const [rest] = lexerParse(code, file);
      for (const imp of rest) {
        if (imp.type !== "import-meta") continue;
        const after = code.slice(imp.end, imp.end + 12);
        const before = code.slice(Math.max(0, imp.start - 300), imp.start);
        // The base of an absolute URL resolves the same from any chunk.
        if (
          /^\.url\b/.test(after) &&
          /new URL\("\/artifacts\/[^"]+",\s*$/.test(before)
        )
          continue;
        // A bare specifier resolves through the import map from anywhere.
        if (/^\.resolve\(["'][^./"']/.test(after)) continue;
        throw new Error(
          `link: ${file} uses import.meta (${JSON.stringify(code.slice(imp.start, imp.end + 30))}) in a form ` +
            `the link cannot keep: bundled into a route chunk, the module has another URL. ` +
            `Only \`new URL("<relative file>", import.meta.url)\` and \`import.meta.resolve("<bare>")\` are kept.`,
        );
      }
    }
    // The module's own sourcemap: rolldown chains it into the chunk's.
    const map = io.read(`${file}.map`);
    return { code, map, statics, dynamics };
  };

  // A module declaring a boot-preloaded live descriptor registers it when it
  // is evaluated, and the boot snapshot hydrates by key BEFORE anything may
  // have imported it: it was registered because its whole barrel was
  // evaluated at boot. With barrels elided, each such module the boot
  // evaluated under barrel semantics — the static closure of the entry, the
  // registry and the eager web barrels, a barrel import meaning its whole
  // `index.js` — is imported by the registry for its effect (below), so
  // exactly what registered before still does (the eager tier pins its
  // plugin for the same reason, `eager-tier.scan.ts`).
  const artifactOfDir = new Map(inputs.artifacts.map((a) => [a.dirName, a]));
  const barrelBoot = new Set<string>([
    inputs.entryDirName,
    inputs.registryDirName,
  ]);
  for (const a of inputs.artifacts) {
    if (
      a.kind === "web" &&
      a.pluginPath !== null &&
      inputs.eager.has(a.pluginPath)
    )
      barrelBoot.add(a.dirName);
  }
  const bootRegistering: string[] = [];
  const seenFiles = new Set<string>();
  const fileQueue = [...barrelBoot].map((d) => `${io.storePath(d)}/index.js`);
  // Each barrel's static closure, as evaluating it did: its own files over
  // relative imports, other barrels over their specifiers.
  while (fileQueue.length > 0) {
    const file = fileQueue.pop()!;
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    const src = sourceOf(file);
    const { dirName } = storeDirOf(file);
    if (artifactOfDir.has(dirName) && BOOT_PRELOAD.test(src.code))
      bootRegistering.push(file);
    for (const imp of src.imports) {
      if (imp.type !== "static" && imp.type !== "reexport-star") continue;
      const target = resolveSpecifier(file, imp.specifier);
      if (target === null) continue;
      barrelBoot.add(storeDirOf(target).dirName);
      fileQueue.push(target);
    }
  }
  const pageScriptFiles = inputs.pageScripts.map((spec) => {
    const file = bySpecifier.get(spec);
    if (file === undefined)
      throw new Error(`link: page script ${spec} is no page artifact`);
    return file;
  });

  // Walk everything the page reaches, statically or not.
  const linked = new Map<string, LinkedModule>();
  const queue = [entryFile, registryFile, ...pageScriptFiles];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (linked.has(file)) continue;
    const m = linkModule(file);
    linked.set(file, m);
    for (const d of m.statics) if (!linked.has(d)) queue.push(d);
    for (const d of m.dynamics) if (!linked.has(d)) queue.push(d);
  }

  // Every registry target must define the plugin (`default`): its loader is
  // typed `{ default: unknown }`, so nothing else catches a missing one.
  for (const target of linked.get(registryFile)!.dynamics) {
    if (
      !sourceOf(target).exports.some(
        (e) => e.type !== "reexport-all" && e.name === "default",
      )
    ) {
      throw new Error(
        `link: ${target} (a registry loader's module) exports no default`,
      );
    }
  }

  // Membership over the elided graph.
  const closure = (
    roots: Iterable<string>,
    outside: ReadonlySet<string> = new Set(),
  ) => {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const f = stack.pop()!;
      if (seen.has(f) || outside.has(f)) continue;
      seen.add(f);
      for (const d of linked.get(f)?.statics ?? []) stack.push(d);
    }
    return seen;
  };
  const definitionsOf = (paths: Iterable<string>): string[] => {
    const wanted = new Set(paths);
    return [...pluginOfDefinition]
      .filter(([def, p]) => wanted.has(p) && linked.has(def))
      .map(([def]) => def);
  };
  const bootRoots = [entryFile, registryFile, ...definitionsOf(inputs.eager)];
  const boot = closure(bootRoots);
  // Each module outside boot, by the set of app roots whose deferred plugins
  // reach it: a module two apps share sits in a group of its own, so neither
  // app's pages load the other's code with it.
  const appRoots = new Map<string, string[]>();
  const appsOf = new Map<string, string[]>(); // module → app roots reaching it
  for (const [root, paths] of Object.entries(inputs.appPlugins).sort()) {
    const roots = definitionsOf(paths);
    appRoots.set(root, roots);
    for (const m of closure(roots, boot)) {
      const list = appsOf.get(m) ?? [];
      list.push(root);
      appsOf.set(m, list);
    }
  }
  const appGroupOf = new Map<string, string>(); // module → group key
  for (const [m, roots] of appsOf) appGroupOf.set(m, roots.join("+"));
  const appGroupKeys = [...new Set(appGroupOf.values())].sort();

  return {
    entryFile,
    registryFile,
    pageScriptFiles,
    linked,
    boot,
    bootRoots,
    bootRegistering,
    barrelBoot,
    appRoots,
    appGroupOf,
    appGroupKeys,
    assetDirs,
    elided,
  };
}

/**
 * Bundle a planned graph into route chunks: one rolldown build, `boot` and
 * each app set a size-split group, lazy code in rolldown's own chunks.
 */
export async function bundleLinkGraph(
  graph: LinkGraph,
  opts: {
    minify: boolean;
    isExternal: (specifier: string) => boolean;
    log: (line: string) => void;
  },
): Promise<OutputChunk[]> {
  const { linked, boot, appGroupOf, appGroupKeys, entryFile, pageScriptFiles } =
    graph;
  // Bundle.
  const { rolldown } = await import("rolldown");
  const bundle = await rolldown({
    input: {
      entry: entryFile,
      ...Object.fromEntries(
        pageScriptFiles.map((f, i) => [`page-script-${i}`, f]),
      ),
    },
    treeshake: true,
    // The entry and page scripts keep their exports; a chunk may export more.
    preserveEntrySignatures: "allow-extension",
    logLevel: "warn",
    onLog(level, log) {
      if (log.code === "CIRCULAR_DEPENDENCY") return;
      // "use client" in a library module: meaningless outside RSC.
      if (log.code === "MODULE_LEVEL_DIRECTIVE") return;
      if (level === "warn") opts.log(`link: warning: ${log.message}`);
    },
    plugins: [
      {
        name: "web-artifacts:link",
        resolveId(id) {
          if (linked.has(id)) return id;
          if (opts.isExternal(id) || isBrowserUnreachableDynamic(id))
            return { id, external: true };
          throw new Error(`link: unresolved module ${id}`);
        },
        load(id) {
          const m = linked.get(id);
          if (m === undefined) throw new Error(`link: unlinked module ${id}`);
          return { code: m.code, map: m.map ?? undefined };
        },
      },
    ],
  });
  const appGroups = appGroupKeys.map((key, i) => ({
    name: `app${i}`,
    test: (id: string) => appGroupOf.get(id) === key,
    maxSize: ROUTE_CHUNK_MAX_BYTES,
    priority: 1,
  }));
  const out = await bundle.generate({
    format: "es",
    sourcemap: true,
    entryFileNames: `${CHUNK_PREFIX}[hash:16]/index.js`,
    chunkFileNames: `${CHUNK_PREFIX}[hash:16]/index.js`,
    // A size-split group is an arbitrary cut through the module graph, so
    // chunks can import each other in a cycle — and a chunk would then run
    // before the bodies of modules it needs (a slot recorded into a
    // registry array not yet initialized). Module bodies run in source order
    // whatever chunk holds them.
    strictExecutionOrder: true,
    hashCharacters: "hex",
    minify: opts.minify
      ? { compress: false, mangle: false, codegen: { removeWhitespace: true } }
      : false,
    codeSplitting: {
      // Each group is closed under its members' dependencies by construction
      // (a dependency of a module is reached by every app reaching the
      // module, and boot is a static closure), so a group must not capture
      // dependencies itself: rolldown's default lets the first group that
      // reaches a module take it, and a page then loads another app's chunk
      // for one shared helper.
      includeDependenciesRecursively: false,
      groups: [
        {
          name: "boot",
          test: (id: string) => boot.has(id),
          maxSize: ROUTE_CHUNK_MAX_BYTES,
          priority: 2,
        },
        ...appGroups,
      ],
    },
  });
  await bundle.close();

  return out.output.filter((o): o is OutputChunk => o.type === "chunk");
}

async function runLink(
  inputs: LinkInputs & {
    key: string;
    pin: (paths: AppPath[]) => Promise<void>;
    log: (line: string) => void;
  },
): Promise<{
  record: LinkRecord;
  chunkMetas: Map<string, ArtifactMeta>;
  modules: LinkModules;
}> {
  const t0 = performance.now();
  const graph = await planLinkGraph(inputs);
  const {
    linked,
    boot,
    bootRoots,
    bootRegistering,
    barrelBoot,
    appRoots,
    appGroupOf,
    assetDirs,
    elided,
    entryFile,
    pageScriptFiles,
  } = graph;
  const output = await bundleLinkGraph(graph, inputs);

  // Publish each chunk as its own store entry.
  const chunkMetas = new Map<string, ArtifactMeta>();
  const chunkOfModule = new Map<string, string>(); // module file → chunk URL
  let entryUrl: string | null = null;
  const pageScripts: Record<string, string> = {};
  const relSpec = (fromFile: string, toFile: string) => {
    const r = posix.relative(posix.dirname(fromFile), toFile);
    return r.startsWith(".") ? r : `./${r}`;
  };
  await Promise.all(
    output.map(async (o) => {
      const [dirName, base] = o.fileName.split("/");
      if (
        dirName === undefined ||
        base !== "index.js" ||
        !dirName.startsWith(CHUNK_PREFIX)
      )
        throw new Error(`link: unexpected chunk file ${o.fileName}`);
      const url = urlOf(dirName, "index.js");
      if (o.isEntry && o.facadeModuleId === entryFile) entryUrl = url;
      const script = pageScriptFiles.indexOf(o.facadeModuleId ?? "");
      if (o.isEntry && script >= 0)
        pageScripts[inputs.pageScripts[script]!] = url;
      for (const id of o.moduleIds) chunkOfModule.set(id, url);
      const meta: ArtifactMeta = {
        specifier: null,
        kind: "chunk",
        pluginPath: null,
        inputsHash: dirName.slice(CHUNK_PREFIX.length),
        staticImportsByFile: {
          "index.js": o.imports.map((i) =>
            i.startsWith(CHUNK_PREFIX) ? relSpec(o.fileName, i) : i,
          ),
        },
        dynamicImports: o.dynamicImports.map((i) =>
          i.startsWith(CHUNK_PREFIX) ? relSpec(o.fileName, i) : i,
        ),
        tailwindCandidates: [],
        builtAtMs: Date.now(),
      };
      chunkMetas.set(dirName, meta);
      await inputs.pin([artifactStorePath(dirName)]);
      if (hasArtifact(dirName)) {
        touchArtifact(dirName);
        return;
      }
      const tmp = artifactTmpDir(dirName);
      writeFileSync(joinAppPath(tmp, "index.js"), o.code);
      if (o.map !== null && o.map !== undefined)
        writeFileSync(joinAppPath(tmp, "index.js.map"), o.map.toString());
      await publishArtifact(dirName, tmp, meta);
    }),
  );
  if (entryUrl === null)
    throw new Error("link: rolldown emitted no entry chunk");
  const unbundled = bootRegistering.filter((f) => !chunkOfModule.has(f));
  if (unbundled.length > 0) {
    throw new Error(
      `link: boot-registering module(s) in no chunk — their descriptors would be missing ` +
        `when the boot snapshot hydrates:\n${unbundled.map((f) => `  ${f}`).join("\n")}`,
    );
  }

  const seedsOf = (roots: Iterable<string>) => {
    const urls = new Set<string>();
    for (const r of roots) {
      const url = chunkOfModule.get(r);
      // A root tree-shaken away entirely (a definition with no code left)
      // has nothing to preload.
      if (url !== undefined) urls.add(url);
    }
    return [...urls].sort();
  };
  const bootSeeds = [
    entryUrl as string,
    ...seedsOf(bootRoots).filter((u) => u !== entryUrl),
  ];
  const appSeeds: Record<string, string[]> = {};
  for (const [root, roots] of appRoots) appSeeds[root] = seedsOf(roots);
  const bootChunks = new Set(
    [...boot].map((m) => chunkOfModule.get(m)).filter((u) => u !== undefined),
  ).size;
  const record: LinkRecord = {
    v: LINK_VERSION,
    key: inputs.key,
    entryUrl,
    chunks: [...chunkMetas.keys()].sort(),
    bootSeeds,
    appSeeds,
    pageScripts,
    assetDirs: [...assetDirs].sort(),
    stats: {
      modules: linked.size,
      bootModules: boot.size,
      bootChunks,
      elidedImports: elided,
    },
  };
  inputs.log(
    `link: ${bootRegistering.length} boot-registering modules in ${barrelBoot.size} boot barrels; ` +
      `${linked.size} modules (${boot.size} boot) → ${chunkMetas.size} chunks ` +
      `(${bootChunks} boot), ${elided} imports elided, ${((performance.now() - t0) / 1000).toFixed(2)}s`,
  );
  // Where each module went: its group and chunk, under its store path.
  const modules: LinkModules = {};
  for (const m of linked.keys()) {
    modules[m.replace(/^.*\/store\//, "")] = {
      group: boot.has(m) ? "boot" : (appGroupOf.get(m) ?? "lazy"),
      chunk: chunkOfModule.get(m) ?? null,
    };
  }
  return { record, chunkMetas, modules };
}

/** Apply non-overlapping edits (in any order) to `code`. */
function applyEdits(
  code: string,
  edits: Array<{ start: number; end: number; text: string }>,
): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const e of sorted) {
    if (e.start < at) throw new Error("link: overlapping edits");
    out += code.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + code.slice(at);
}
