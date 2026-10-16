// Per-plugin builder: Vite programmatic `build()` in lib mode, in-process, one
// Rollup graph per plugin. Reuses today's exact semantics: `@vitejs/plugin-react`
// with the discovered babel contributions, CSS imports (local + npm package CSS,
// injected from JS so styles load atomically with the module), `define`,
// esbuild `keepNames`. NO `@tailwindcss/vite` here — utilities come from the
// single global pass (see `global-css.ts`).

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Plugin as VitePlugin } from "vite";
import { init as esLexerInit, parse as esLexerParse } from "es-module-lexer";
import type { BabelPluginItem } from "@plugins/framework/plugins/web-core/core";
import {
  COMPOSITION_REGISTRY_SPECIFIER,
  CONFIG_LAYER_ARTIFACT_FILE,
} from "../composition-modules";
import { WORKER_ASSETS_DIR } from "../constants";
import { makeArtifactExternal } from "../externals";
import { inlinedRootsFor } from "../own-roots";
import { createInlineAudit } from "./inline-audit";
import { hashedRootsFor } from "./own-files";
import type { ArtifactMeta } from "./store";
import { artifactTmpDir, publishArtifact } from "./store";

export interface BuilderCtx {
  repoRoot: string;
  pluginsRoot: string;
  babelPlugins: BabelPluginItem[];
  minify: boolean;
}

export interface ArtifactBuildTarget {
  /** Store dir name (`<slug>.<kind>.<hash16>`). */
  dirName: string;
  /** `web`, `entry`, or a folder-barrel kind (`core`, `prewarm`, …). */
  kind: string;
  /** null for the entry artifact. */
  pluginPath: string | null;
  /** The import-map specifier this artifact will serve (null for entry). */
  specifier: string | null;
  entryFile: string;
  inputsHash: string;
  /**
   * Extra entries built into THIS artifact (a co-built folder such as
   * `exhibits/` of a `web` artifact — `COBUILT_FOLDERS` in `../own-roots.ts`).
   * Empty for every ordinary artifact. Required, so no target constructor can
   * forget to say whether it carries any.
   */
  coEntries: readonly CoEntry[];
}

/** A co-built folder's entry inside its host artifact. */
export interface CoEntry {
  /** The plugin folder (`exhibits`) — also the emitted file's name, `<folder>.js`. */
  folder: string;
  /** Absolute path of the folder's barrel. */
  entryFile: string;
  /** The import-map specifier served by `<folder>.js` (`@plugins/<p>/<folder>`). */
  specifier: string;
}

/** The emitted file a co-entry is served from, inside its host artifact dir. */
export function coEntryFileName(entry: Pick<CoEntry, "folder">): string {
  return `${entry.folder}.js`;
}

/**
 * Rung-4 guard of "a co-entry is never on the boot path": no file the host
 * entry (`index.js`) statically reaches may be a co-entry file. `web/` cannot
 * import `exhibits/` (leaf folders are never import targets), so this holds by
 * the boundary rules — the throw covers a build that skipped them. Without it,
 * the modulepreload closure (which follows static edges from `index.js`) would
 * silently put every exhibit in the eager boot bundle.
 */
export function assertCoEntriesOffHostPath(opts: {
  dirName: string;
  staticImportsByFile: Record<string, string[]>;
  coEntries: readonly CoEntry[];
}): void {
  const coFiles = new Set(opts.coEntries.map(coEntryFileName));
  const seen = new Set<string>();
  const queue = ["index.js"];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (coFiles.has(file)) {
      throw new Error(
        `web-artifact ${opts.dirName}: index.js statically reaches ${file}, a co-built ` +
          `entry. Co-entries must be reachable only through their registry's dynamic ` +
          `import, or they join the eager modulepreload closure. Something in web/ ` +
          `imports the co-built folder — remove that import.`,
      );
    }
    for (const spec of opts.staticImportsByFile[file] ?? []) {
      if (spec.startsWith("./")) queue.push(spec.slice(2));
    }
  }
}

// Neither pin is baked into artifacts (either would churn every hash every
// build). `import.meta.env.VITE_BUILD_GRAPH` / `VITE_BUILD_COMMIT` compile to
// the plain global identifiers below, declared by an inline script the compose
// step injects into index.html — so a bundle can name itself while its code
// stays content-addressed.
//
// The graph hash is the bundle's CONTENT identity (a pure function of the
// composed module graph), not the id of the run that produced it: two builds of
// an unchanged tree compose the same graph, so a tab holding it is not stale.
// The commit is the tree the graph was built from.
export const GRAPH_GLOBAL = "__SINGULARITY_GRAPH__";
export const COMMIT_GLOBAL = "__SINGULARITY_COMMIT__";

const ARTIFACT_DEFINE: Record<string, string> = {
  "import.meta.env.DEV": "false",
  "import.meta.env.PROD": "true",
  "import.meta.env.MODE": JSON.stringify("production"),
  "import.meta.env.VITE_BUILD_GRAPH": GRAPH_GLOBAL,
  "import.meta.env.VITE_BUILD_COMMIT": COMMIT_GLOBAL,
  // Vite's APP build replaces this automatically, but LIB mode deliberately
  // preserves it — and `process` does not exist in the browser, so any
  // first-party or inlined npm code branching on NODE_ENV would crash at
  // runtime. Match the monolith (and the vendor esbuild pass, vendors.ts).
  "process.env.NODE_ENV": JSON.stringify("production"),
};

/** Path segments below an own folder that still name its barrel. */
function isBarrelPath(below: readonly string[]): boolean {
  return (
    below.length === 0 ||
    (below.length === 1 && /^index\.(ts|tsx|js)$|^index$/.test(below[0]!))
  );
}

/**
 * Route EVERY import that lands in one of the plugin's own NON-inlined folders
 * through that folder's external `@plugins/<path>/<folder>` barrel. One URL =
 * one module instance: inlining any file of that folder next to the artifact
 * everyone else loads would double-instantiate its module state (live-state's
 * descriptor registry and config_v2's descriptor identities were real
 * casualties, and the Layout Lab ran two copies of a plugin's web module for
 * the same reason). It is also what keeps the artifact's address honest: only
 * the inlined roots are hashed, so any other own folder reaching the bytes
 * would fossilise the artifact — see `../own-roots.ts`.
 *
 * Which folders are inlined is `inlinedRootsFor(kind)`, so the rule needs no
 * per-kind special case: building `core` inlines core's internal edges because
 * `core` IS its inlined root, and building `web` never reaches a file under
 * `core/` at all because every entry into it is rewritten (or refused) here.
 *
 * Only the BARREL spelling is rewritten; a deep path (`../core/resource`,
 * `@plugins/<own>/core/x`) is refused. Rewriting it would make the import mean
 * the barrel in the browser while `tsc` reads it as the file, so a symbol the
 * barrel does not export type-checked green and failed only at compose, ~5
 * minutes into a build. Own symbols consumed across a folder boundary are the
 * folder's public API by construction — export them from its barrel. The
 * `runtime-isolation/no-deep-own-folder-import` lint rule catches the same
 * import in the editor; this throw is for what lint cannot see (generated
 * files, disabled lines, `--skip-checks`).
 */
export function ownFolderBarrelPlugin(
  pluginPath: string,
  pluginDir: string,
  kind: string,
): VitePlugin {
  const inlinedRoots = inlinedRootsFor(kind);
  return {
    name: "web-artifacts:own-folder-barrel",
    enforce: "pre",
    resolveId(id, importer) {
      if (!importer) return null;
      if (id.includes("?")) return null; // vite query suffix — not a source edge to reroute
      if (id.endsWith(".css")) return null; // css stays in-graph (see ../externals.ts)
      // Relative ids resolve against the importer; vite's alias plugin has
      // already rewritten `@plugins/<own>/…` to an absolute path.
      const target =
        id.startsWith("./") || id.startsWith("../")
          ? resolve(dirname(importer), id)
          : isAbsolute(id)
            ? id
            : null;
      if (target === null) return null;
      const rel = relative(pluginDir, target);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null; // outside our tree
      const [folder, ...below] = rel.split(sep) as [string, ...string[]];
      if (folder === "node_modules") return null; // plugin-local npm deps
      if (folder === "plugins") return null; // sub-plugins are other plugins (external by specifier)
      if (inlinedRoots.includes(folder)) return null;
      if (!isBarrelPath(below)) {
        throw new Error(
          `web-artifact ${pluginPath} (kind "${kind}"): ${importer} imports "${id}", a file ` +
            `inside the plugin's own "${folder}/". The browser can only load "${folder}/" as ` +
            `its barrel artifact (@plugins/${pluginPath}/${folder}), so this import would ` +
            `silently mean the barrel — and fail at compose if the barrel does not export ` +
            `what it names. Import from the "${folder}/" barrel and export the symbol from ` +
            `${folder}/index.ts (lint: runtime-isolation/no-deep-own-folder-import).`,
        );
      }
      if (!existsSync(join(pluginDir, folder, "index.ts"))) {
        throw new Error(
          `web-artifact ${pluginPath} (kind "${kind}"): ${importer} imports "${id}", which ` +
            `lands in the plugin's own "${folder}/" — a folder this artifact neither inlines ` +
            `nor hashes, and which has no ${folder}/index.ts barrel to route the import to. ` +
            `Give it a barrel and import through it, or add "${folder}" to inlinedRootsFor() ` +
            `in core/own-roots.ts.`,
        );
      }
      return { id: `@plugins/${pluginPath}/${folder}`, external: true };
    },
  };
}

/**
 * Entry-artifact only: the global stylesheet import in `main.tsx`
 * (`…/ui-kit/web/theme/app.css`) is satisfied by the compose step's `<link>` to
 * the global Tailwind pass output — strip it to an empty module so it is
 * neither bundled nor externalized as a bogus module URL. Suffix-matched
 * because vite's alias plugin rewrites `@plugins/...` to the absolute path
 * BEFORE `pre` plugins run.
 */
function stripGlobalCssPlugin(): VitePlugin {
  return {
    name: "web-artifacts:strip-global-css",
    enforce: "pre",
    resolveId(id) {
      if (id.endsWith("/ui-kit/web/theme/app.css")) {
        return "\0web-artifacts:global-css-stub";
      }
      return null;
    },
    load(id) {
      if (id === "\0web-artifacts:global-css-stub") return "export {};\n";
      return null;
    },
  };
}

/**
 * Each chunk carries the CSS of its own modules, injected when the chunk runs.
 * A dynamically imported chunk's styles (KaTeX's 1.4 MB stylesheet, behind
 * `lazyComponent`) therefore load with that chunk, never with the entry — so
 * they stay off the eager boot path the way its code does. An exhibit entry and
 * `index.js` that share styles share them through the chunk both import.
 *
 * Needs `cssCodeSplit` (vite's lib mode defaults it off, which merges every
 * chunk's CSS into one file). Every CSS asset must belong to a chunk: an
 * orphan would be a style no module ever applies, so it throws.
 */
export function chunkCssPlugin(dirName: string): VitePlugin {
  return {
    name: "web-artifacts:chunk-css",
    enforce: "post",
    generateBundle(_opts, bundle) {
      const claimed = new Set<string>();
      for (const out of Object.values(bundle)) {
        if (out.type !== "chunk") continue;
        const files = [...(out.viteMetadata?.importedCss ?? [])];
        if (files.length === 0) continue;
        const css = files
          .map((f) => {
            const asset = bundle[f];
            if (asset?.type !== "asset")
              throw new Error(
                `vite build of ${dirName}: chunk ${out.fileName} imports CSS ${f}, which is not in the bundle`,
              );
            claimed.add(f);
            return typeof asset.source === "string"
              ? asset.source
              : new TextDecoder().decode(asset.source);
          })
          .join("\n");
        out.code += cssInjectionSnippet(css, dirName);
      }
      for (const [fileName, out] of Object.entries(bundle)) {
        if (out.type !== "asset" || !fileName.endsWith(".css")) continue;
        if (!claimed.has(fileName))
          throw new Error(
            `vite build of ${dirName}: CSS ${fileName} belongs to no chunk`,
          );
        delete bundle[fileName];
      }
    },
  };
}

/** Wrap extracted CSS into a JS snippet appended to the module (atomic load). */
function cssInjectionSnippet(css: string, dirName: string): string {
  return (
    `\n;(function(){` +
    `if(typeof document>"u")return;` +
    `var s=document.createElement("style");` +
    `s.setAttribute("data-web-artifact",${JSON.stringify(dirName)});` +
    `s.textContent=${JSON.stringify(css)};` +
    `document.head.appendChild(s);` +
    `})();\n`
  );
}

/**
 * Rung-4 guard of "a worker bundle is self-contained": a module worker resolves
 * its imports against its own URL — the page's import map does not reach it —
 * so any import left in a worker chunk would 404 (a bare specifier) or load a
 * second, unhashed copy of a sibling file. Vite's worker pass bundles the
 * worker's whole closure; this asserts it did. Throws on any import, static or
 * dynamic. Returns the worker chunk names (relative to the artifact dir).
 */
export async function assertWorkersSelfContained(opts: {
  dirName: string;
  outDir: string;
}): Promise<string[]> {
  const dir = join(opts.outDir, WORKER_ASSETS_DIR);
  if (!existsSync(dir)) return [];
  await esLexerInit;
  const workers: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".js")) continue;
    const rel = `${WORKER_ASSETS_DIR}/${name}`;
    const [imports] = esLexerParse(readFileSync(join(dir, name), "utf8"), rel);
    const specs = imports.map((imp) => imp.n ?? "<dynamic expression>");
    if (specs.length > 0) {
      throw new Error(
        `web-artifact ${opts.dirName}: worker chunk ${rel} imports ${specs.join(", ")}. ` +
          `A worker cannot use the page's import map, so its bundle must be ` +
          `self-contained: import only the plugin's own files (no other plugin, ` +
          `no dynamic import).`,
      );
    }
    workers.push(rel);
  }
  return workers;
}

/**
 * Parse EVERY emitted module's external imports. An artifact with internal
 * dynamic imports (lazy-component) code-splits into `.mjs` chunks next to
 * `index.js` — the chunks' imports are as load-bearing as the entry's (a bare
 * specifier only a lazy chunk imports still needs a vendor + map entry).
 * Statics are recorded PER FILE so the preload BFS walks real static edges and
 * never eagerly preloads a lazy chunk's dependencies.
 */
export async function parseEmittedImports(outDir: string): Promise<{
  staticImportsByFile: Record<string, string[]>;
  dynamicImports: string[];
}> {
  await esLexerInit;
  const staticImportsByFile: Record<string, string[]> = {};
  const dynamicImports = new Set<string>();
  for (const name of readdirSync(outDir).sort()) {
    if (!name.endsWith(".js") && !name.endsWith(".mjs")) continue;
    const code = readFileSync(join(outDir, name), "utf8");
    const [imports] = esLexerParse(code, name);
    const statics = new Set<string>();
    for (const imp of imports) {
      if (imp.n === undefined) continue;
      if (imp.d >= 0) dynamicImports.add(imp.n);
      else if (imp.d === -1) statics.add(imp.n);
    }
    staticImportsByFile[name] = [...statics].sort();
  }
  return {
    staticImportsByFile,
    dynamicImports: [...dynamicImports].sort(),
  };
}

/**
 * Build ONE artifact into the store. Throws on any build error (fail loudly —
 * the pipeline surfaces which plugin failed).
 */
export async function buildArtifact(
  target: ArtifactBuildTarget,
  ctx: BuilderCtx,
): Promise<ArtifactMeta> {
  // Lazy: the vite/babel toolchain (~2s of module eval) must load only when an
  // artifact actually builds, never on plain CLI startup or docgen barrel import.
  const [{ build: viteBuild }, { default: react }] = await Promise.all([
    import("vite"),
    import("@vitejs/plugin-react"),
  ]);
  const tmpDir = artifactTmpDir(target.dirName);
  // The dir the artifact's own-hash was taken against: the plugin dir for a
  // plugin target, and (for `entry`) web-core's `web/` — which is exactly what
  // `planFleet` passes to `ownHashFor`, so `hashedRootsFor` answers identically
  // for both and the audit checks the roots the address really hashed.
  const pluginDir = target.pluginPath
    ? join(ctx.pluginsRoot, target.pluginPath)
    : dirname(target.entryFile);
  const audit = createInlineAudit({
    dirName: target.dirName,
    hashedRoots: hashedRootsFor(pluginDir, target.kind),
    kind: target.kind,
  });
  // A worker (`new SharedWorker(new URL("./x.worker.ts", import.meta.url))`) is
  // built by vite's own nested rollup pass, which runs `worker.plugins` — not
  // the main build's. It bundles its whole closure (no externals: import maps
  // do not reach workers), so the same address-covers-content audit must watch
  // it: a worker reaching another plugin's file fails here instead of
  // fossilising unhashed bytes.
  const workerAudit = createInlineAudit({
    dirName: `${target.dirName} (worker)`,
    hashedRoots: hashedRootsFor(pluginDir, target.kind),
    kind: target.kind,
  });

  const plugins: VitePlugin[] = [audit.plugin, chunkCssPlugin(target.dirName)];
  if (target.kind === "entry") plugins.push(stripGlobalCssPlugin());
  if (target.pluginPath) {
    plugins.push(
      ownFolderBarrelPlugin(target.pluginPath, pluginDir, target.kind),
    );
  }

  const multiEntry = target.coEntries.length > 0;
  const lib = multiEntry
    ? {
        entry: {
          index: target.entryFile,
          ...Object.fromEntries(
            target.coEntries.map((e) => [e.folder, e.entryFile]),
          ),
        },
        formats: ["es" as const],
        fileName: (_format: string, entryName: string) => `${entryName}.js`,
      }
    : {
        entry: target.entryFile,
        formats: ["es" as const],
        fileName: () => "index.js",
      };

  try {
    await viteBuild({
      configFile: false,
      logLevel: "error",
      root: ctx.repoRoot,
      plugins: [...plugins, react({ babel: { plugins: ctx.babelPlugins } })],
      esbuild: { keepNames: true },
      define: ARTIFACT_DEFINE,
      resolve: { alias: { "@plugins": ctx.pluginsRoot } },
      // Relative: an artifact is served from a content-addressed store dir, so
      // a worker chunk's URL must resolve against `import.meta.url`; the
      // default "/" emitted an origin-absolute `/assets/…` that 404s.
      base: "./",
      worker: { format: "es", plugins: () => [workerAudit.plugin] },
      build: {
        lib,
        outDir: tmpDir,
        emptyOutDir: true,
        minify: ctx.minify ? "esbuild" : false,
        // Per-chunk CSS, injected by `chunkCssPlugin`.
        cssCodeSplit: true,
        sourcemap: true,
        reportCompressedSize: false,
        rollupOptions: {
          external: makeArtifactExternal(target.pluginPath, target.kind),
        },
      },
    });
    // Before anything reads the output: prove the bytes inline only what this
    // artifact's address hashed (see `inline-audit.ts`).
    audit.verify();
    workerAudit.verify();

    // `chunkCssPlugin` folded every chunk's CSS into that chunk.
    const strayCss = readdirSync(tmpDir).filter((f) => f.endsWith(".css"));
    if (strayCss.length > 0)
      throw new Error(
        `vite build of ${target.dirName} left CSS outside its chunks: ${strayCss.join(", ")}`,
      );

    for (const file of ["index.js", ...target.coEntries.map(coEntryFileName)]) {
      if (!existsSync(join(tmpDir, file))) {
        throw new Error(`vite build of ${target.dirName} emitted no ${file}`);
      }
    }

    await assertWorkersSelfContained({
      dirName: target.dirName,
      outDir: tmpDir,
    });
    const { staticImportsByFile, dynamicImports } =
      await parseEmittedImports(tmpDir);
    assertCoEntriesOffHostPath({
      dirName: target.dirName,
      staticImportsByFile,
      coEntries: target.coEntries,
    });
    const meta: ArtifactMeta = {
      specifier: target.specifier,
      kind: target.kind,
      pluginPath: target.pluginPath,
      inputsHash: target.inputsHash,
      staticImportsByFile,
      dynamicImports,
      builtAtMs: Date.now(),
    };
    publishArtifact(target.dirName, tmpDir, meta);
    return meta;
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(
      `web-artifact build failed for ${target.dirName} (entry ${target.entryFile}): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
}

/**
 * The registry artifact — the composition artifact (`composition-modules.ts`):
 * one file per composition module, each type-stripped to plain ESM. No bundling
 * — neither file has a static import.
 *
 * - `index.js` ← `web.generated.ts`, its `() => import("@plugins/…/web")`
 *   dynamic imports preserved as bare specifiers (the import map resolves them).
 * - `config-layer.js` ← the composition's config layer (pure data).
 */
export async function buildRegistryArtifact(opts: {
  dirName: string;
  inputsHash: string;
  registryFile: string;
  configLayerFile: string;
  minify: boolean;
}): Promise<ArtifactMeta> {
  const { transform } = await import("esbuild");
  const tmpDir = artifactTmpDir(opts.dirName);
  const modules = [
    { file: opts.registryFile, out: "index.js" },
    { file: opts.configLayerFile, out: CONFIG_LAYER_ARTIFACT_FILE },
  ];
  for (const m of modules) {
    const result = await transform(readFileSync(m.file, "utf8"), {
      loader: "ts",
      format: "esm",
      minify: opts.minify,
      keepNames: true,
      sourcemap: true,
      sourcefile: basename(m.file),
    });
    writeFileSync(
      join(tmpDir, m.out),
      `${result.code}\n//# sourceMappingURL=${m.out}.map\n`,
    );
    writeFileSync(join(tmpDir, `${m.out}.map`), result.map);
  }
  const { staticImportsByFile, dynamicImports } =
    await parseEmittedImports(tmpDir);
  const meta: ArtifactMeta = {
    specifier: COMPOSITION_REGISTRY_SPECIFIER,
    kind: "registry",
    pluginPath: null,
    inputsHash: opts.inputsHash,
    staticImportsByFile,
    dynamicImports,
    builtAtMs: Date.now(),
  };
  publishArtifact(opts.dirName, tmpDir, meta);
  return meta;
}
