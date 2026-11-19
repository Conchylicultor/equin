// A worker tree's code, bundled into a few files the worker requests at once.
//
// The tree (`worker-link.ts`) lays a browser host's closure out as one linked
// artifact copy per plugin barrel (~720 for the website demo), each naming its
// dependencies by a relative URL into the tree. Loaded as is, the worker found
// that code one import level at a time — a module's imports are known only
// once it arrives, and the plugin graph's load waves import each barrel when
// its wave comes: 1,806 requests, 2.1 MB in ~13 s on fast 4G, using a fifth of
// the link (research/2026-11-17-apps-website-demo-enter-cost.md). Import maps
// do not reach workers, so the page's route chunks (`link.ts`) never applied.
//
// Here the same tree is bundled with rolldown into `_bundle/` inside it:
//
// - **The boot set is known at build time**, per host: the static closure of
//   its entry and of the entry's OWN dynamic imports — a host entry's
//   `import()`s are its plugin graph's loaders (`bootBrowserHost` boots
//   every one before it serves). Its two parts are grouped apart: the
//   entry's static closure (what must run first: the storage open, the
//   progress reports) and the plugin graph's rest. Each group is cut into
//   chunks at places its module keys decide (`cutByKeys`, as route chunks
//   are), so a module's growth moves at most the cut after it; a module two
//   hosts reach sits in a group of its own (as two apps' shared code does).
// - **Requested at once, without waiting on it**: the entry chunk statically
//   imports only its own start, then — the moment it runs — requests every
//   chunk of its plugin graph with `import()`, so the browser fetches them in
//   parallel while the host opens its storage and fetches its starting data
//   (the worker's equivalent of the page's modulepreload list).
//   `strictExecutionOrder` keeps every module body behind its own init call,
//   so loading a chunk early runs no module before its importer asks for it:
//   the modules' order is the source's, as before. An external vendor module
//   is evaluated when the first chunk importing it loads — earlier than its
//   first importer's body, as with any static import.
// - Code reached only by a dynamic import outside the entry (a lazy module of
//   a server plugin) keeps rolldown's own chunking, and loads when asked.
// - The vendor set (`_vendor/`, the page's same files: one HTTP cache entry
//   for both) and the host snapshot (`<id>.snapshot/`) stay external, at the
//   same `../` depth from `_bundle/` as from any linked artifact's `index.js`.
// - `new URL("<rel>", import.meta.url)` is respelled from the bundle file to
//   the original file's place in the tree; any other `import.meta` keeps
//   meaning "this code's URL" (persisted live values stamp it).
//
// The bundle lives inside the tree's store entry, whose name already hashes
// every input (the links, the entries and WORKER_BUNDLE_VERSION): the entry
// URL (`workerBundleEntry`) is known without bundling, so map-in-sync derives
// the import map's worker entry purely, as before.

import { posix } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  readFileSync,
  realpathSync,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  appPathParent,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { init as lexerInit, parse as lexerParse } from "es-module-lexer";
import { cutByKeys } from "./link";
import {
  IMPORT_ONCE_CALL,
  IMPORT_ONCE_HELPER,
  rewriteImportEdits,
} from "./dedupe-dynamic-imports";
import { HOST_SNAPSHOT_LINK_KIND } from "./host-snapshots";

/** Bump to re-bundle every worker tree (a hash input of the tree's name). */
export const WORKER_BUNDLE_VERSION = 1;

/** The tree's subdirectory holding the bundle. */
export const WORKER_BUNDLE_DIR = "_bundle";

/**
 * The mean size of a boot chunk, in bytes of the linked modules (before
 * rolldown re-prints them). Larger than a page route chunk's: a worker's set
 * is fetched whole and at once, so fewer files cost nothing in laziness —
 * the website demo's ~8 MB of linked server code is ~30 files.
 */
const WORKER_CHUNK_TARGET_BYTES = 300_000;

/** The external spelling of a tree file the bundle does not hold. */
const TREE_EXTERNAL = "worker-tree:";

const SOURCEMAP_COMMENT = /\n?\/\/# sourceMappingURL=[^\n]*\s*$/;

/** The tree-relative file of a host entry's bundle (`_bundle/<link>.js`). */
export function workerBundleEntry(entryLinkName: string): string {
  return `${WORKER_BUNDLE_DIR}/${entryLinkName}.js`;
}

/**
 * Whether a tree-relative path is outside the bundle — the vendor set, or a
 * host snapshot (both loaded by URL, both shared with what else fetches them).
 */
function isExternalTreePath(rel: string, vendorLink: string): boolean {
  const top = rel.split("/")[0]!;
  return top === vendorLink || top.endsWith(`.${HOST_SNAPSHOT_LINK_KIND}`);
}

interface TreeModule {
  code: string;
  map: string | null;
  statics: AppPath[];
  dynamics: AppPath[];
}

/**
 * Bundle the tree at `treeDir` (its links already laid out) into
 * `<treeDir>/_bundle/`: one file per entry (`entries`: link names of the host
 * entries) plus the chunks. Throws on anything it cannot keep.
 */
export async function bundleWorkerTree(opts: {
  /** The tree's staging dir, inside the artifact store. */
  treeDir: AppPath;
  entries: readonly string[];
  vendorLink: string;
  log: (line: string) => void;
}): Promise<{ files: number; bootChunks: number; modules: number }> {
  const t0 = performance.now();
  const { treeDir } = opts;
  await lexerInit();
  const relOf = (file: string) => posix.relative(treeDir, file);

  const resolve = (importer: string, spec: string): AppPath | null => {
    if (spec.startsWith("data:")) return null;
    if (!spec.startsWith("./") && !spec.startsWith("../")) {
      throw new Error(
        `worker bundle: ${relOf(importer)} imports "${spec}" — a linked tree file names every import by a relative URL`,
      );
    }
    const file = new URL(spec, `file://${importer}`).pathname;
    const rel = relOf(file);
    if (rel.startsWith("..")) {
      throw new Error(
        `worker bundle: ${relOf(importer)} imports "${spec}", outside the tree`,
      );
    }
    return isExternalTreePath(rel, opts.vendorLink)
      ? null
      : joinAppPath(treeDir, rel);
  };

  const modules = new Map<string, TreeModule>();
  const read = (file: AppPath): TreeModule => {
    const known = modules.get(file);
    if (known !== undefined) return known;
    let code = readFileSync(file, "utf8").replace(SOURCEMAP_COMMENT, "\n");
    // A file beside the module, addressed from where the bundle file sits:
    // `_bundle/` is one level deep, as the module's artifact dir is.
    const dir = posix.dirname(relOf(file));
    code = code.replace(
      /new URL\(\s*(["'])([^"'`]+)\1\s*,\s*import\.meta\.url\s*\)/g,
      (m, _q: string, rel: string) => {
        if (/^[a-z]+:/i.test(rel) || rel.startsWith("/")) return m;
        const inTree = posix.normalize(posix.join(dir, rel));
        if (inTree.startsWith("..")) {
          throw new Error(
            `worker bundle: ${relOf(file)} addresses ${rel}, outside the tree`,
          );
        }
        return `new URL(${JSON.stringify(`../${inTree}`)},import.meta.url)`;
      },
    );
    const [imports] = lexerParse(code, file);
    const statics: AppPath[] = [];
    const dynamics: AppPath[] = [];
    for (const imp of imports) {
      if (imp.type === "import-meta") continue;
      if (imp.specifier === undefined) {
        throw new Error(
          `worker bundle: ${relOf(file)} has a dynamic import() of a computed specifier`,
        );
      }
      const target = resolve(file, imp.specifier);
      if (target === null) continue;
      (imp.type === "dynamic" ? dynamics : statics).push(target);
    }
    let map: string | null = null;
    try {
      const raw = readFileSync(
        joinAppPath(appPathParent(file), `${posix.basename(file)}.map`),
        "utf8",
      );
      // Its sources are relative to the artifact's own file in the store,
      // one level shallower than its link in the tree: resolved there, so
      // the bundle's map names the real sources.
      const parsed = JSON.parse(raw) as {
        sources?: Array<string | null>;
        sourceRoot?: string;
      };
      const real = `file://${realpathSync(file)}`;
      const base = new URL(parsed.sourceRoot ?? "", real);
      parsed.sources = (parsed.sources ?? []).map((src) =>
        src === null ? null : new URL(src, base).pathname,
      );
      delete parsed.sourceRoot;
      map = JSON.stringify(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const m: TreeModule = { code, map, statics, dynamics };
    modules.set(file, m);
    return m;
  };

  // Every module the bundle reaches.
  const entryFiles = opts.entries.map((e) =>
    joinAppPath(treeDir, e, "index.js"),
  );
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (modules.has(f)) continue;
    const m = read(f);
    queue.push(...m.statics, ...m.dynamics);
  }
  const staticClosure = (roots: Iterable<string>): Set<string> => {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      stack.push(...modules.get(f)!.statics);
    }
    return seen;
  };
  // Per host: its start (the entry's static closure) and its boot set.
  const hosts = opts.entries.map((e, i) => {
    const entryFile = entryFiles[i]!;
    const loaders: string[] = [];
    for (const [file, m] of modules)
      if (relOf(file).startsWith(`${e}/`)) loaders.push(...m.dynamics);
    const start = staticClosure([entryFile]);
    return { start, boot: staticClosure([entryFile, ...loaders]) };
  });
  // A module's group: which hosts boot it, and whether one runs it first.
  const groupOf = new Map<string, string>();
  hosts.forEach((h, i) => {
    for (const m of h.boot) {
      const prev = groupOf.get(m);
      const part = `${i}${h.start.has(m) ? "s" : "g"}`;
      groupOf.set(m, prev === undefined ? part : `${prev}+${part}`);
    }
  });
  const boot = new Set(groupOf.keys());
  const chunkNameOf = new Map<string, string>();
  const groupKeys = [...new Set(groupOf.values())].sort();
  groupKeys.forEach((key, g) => {
    const members = [...groupOf].filter(([, k]) => k === key).map(([m]) => m);
    const pieces = cutByKeys(
      members,
      relOf,
      (m) => modules.get(m)!.code.length,
      WORKER_CHUNK_TARGET_BYTES,
    );
    for (const [m, piece] of pieces) chunkNameOf.set(m, `boot${g}-${piece}`);
  });

  const respell = (spec: string) =>
    spec.startsWith(TREE_EXTERNAL)
      ? `../${spec.slice(TREE_EXTERNAL.length)}`
      : spec;
  const { rolldown, RolldownMagicString } = await import("rolldown");
  const bundle = await rolldown({
    input: Object.fromEntries(opts.entries.map((e, i) => [e, entryFiles[i]!])),
    treeshake: true,
    preserveEntrySignatures: "allow-extension",
    logLevel: "warn",
    onLog(level, log) {
      if (log.code === "CIRCULAR_DEPENDENCY") return;
      if (log.code === "MODULE_LEVEL_DIRECTIVE") return;
      if (level === "warn") opts.log(`worker bundle: warning: ${log.message}`);
    },
    plugins: [
      {
        name: "web-artifacts:worker-bundle",
        resolveId(id, importer) {
          if (modules.has(id)) return id;
          if (importer === undefined)
            throw new Error(`worker bundle: unresolved entry ${id}`);
          const file = resolve(importer, id);
          if (file !== null) return file;
          return id.startsWith("data:")
            ? { id, external: true }
            : {
                id: `${TREE_EXTERNAL}${relOf(new URL(id, `file://${importer}`).pathname)}`,
                external: true,
              };
        },
        load(id) {
          const m = modules.get(id);
          if (m === undefined)
            throw new Error(`worker bundle: unread module ${id}`);
          return { code: m.code, map: m.map ?? undefined };
        },
        async renderChunk(code) {
          const edits = await rewriteImportEdits(code, respell);
          if (edits.length === 0) return null;
          const s = new RolldownMagicString(code);
          for (const e of edits) s.overwrite(e.start, e.end, e.text);
          if (edits.some((e) => e.text.startsWith(IMPORT_ONCE_CALL)))
            s.prepend(IMPORT_ONCE_HELPER);
          return s;
        },
      },
    ],
  });
  const out = await bundle.generate({
    format: "es",
    sourcemap: true,
    entryFileNames: "[name].js",
    chunkFileNames: "c-[hash].js",
    hashCharacters: "hex",
    // As the route chunks (link.ts): a key cut makes chunk cycles, and a
    // chunk must not run before its dependencies' bodies; and every module
    // body behind an init call is what makes loading the plugin graph's
    // chunks from the entry (below) free of evaluation.
    strictExecutionOrder: true,
    minifyInternalExports: false,
    minify: {
      compress: false,
      mangle: false,
      codegen: { removeWhitespace: true },
    },
    codeSplitting: {
      includeDependenciesRecursively: false,
      groups: [
        {
          debugName: "worker-boot",
          name: (id: string) => chunkNameOf.get(id) ?? null,
          test: (id: string) => chunkNameOf.has(id),
        },
      ],
    },
  });
  await bundle.close();

  const chunks = new Map(
    out.output.flatMap((o) => (o.type === "chunk" ? [[o.fileName, o]] : [])),
  );
  const bootFiles = new Set<string>();
  for (const o of chunks.values())
    if (o.moduleIds.some((m) => boot.has(m))) bootFiles.add(o.fileName);
  /** The files a chunk's static imports load with it. */
  const loadedWith = (file: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [file];
    while (stack.length > 0) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const c = chunks.get(f);
      if (c !== undefined) stack.push(...c.imports);
    }
    return seen;
  };
  const outDir = joinAppPath(treeDir, WORKER_BUNDLE_DIR);
  mkdirSync(outDir, { recursive: true });
  let files = 0;
  for (const o of out.output) {
    if (o.type === "asset" && o.fileName.endsWith(".map")) {
      writeFileSync(joinAppPath(outDir, o.fileName), o.source);
      continue;
    }
    if (o.type !== "chunk") {
      throw new Error(
        `worker bundle: rolldown emitted an asset (${o.fileName}) — a worker tree's files stay in their artifacts`,
      );
    }
    let code = o.code;
    if (o.isEntry) {
      // The rest of this host's boot set, requested as soon as the entry
      // runs (after its own body has started the storage). A chunk failing
      // here is imported again by the plugin graph's loader, whose rejection
      // the host reports — this request only starts the download early.
      // Appended before the sourcemap comment, on a line of its own: the
      // mapped lines keep their places.
      const host = hosts[opts.entries.indexOf(o.name)]!;
      const started = loadedWith(o.fileName);
      const graph = [...chunks.values()]
        .filter(
          (c) =>
            !started.has(c.fileName) &&
            c.moduleIds.some((m) => host.boot.has(m)),
        )
        .map((c) => `./${c.fileName}`)
        .sort();
      const preload =
        graph.length === 0
          ? ""
          : `for(const u of ${JSON.stringify(graph)})import(u).catch(()=>{});`;
      if (preload !== "") {
        const at = code.search(SOURCEMAP_COMMENT);
        code =
          at < 0
            ? `${code}\n${preload}\n`
            : `${code.slice(0, at)}\n${preload}${code.slice(at)}`;
      }
    }
    writeFileSync(joinAppPath(outDir, o.fileName), code);
    files++;
  }
  opts.log(
    `worker bundle: ${modules.size} modules (${boot.size} boot) → ${files} files ` +
      `(${bootFiles.size} boot), ${((performance.now() - t0) / 1000).toFixed(2)}s`,
  );
  return { files, bootChunks: bootFiles.size, modules: modules.size };
}
