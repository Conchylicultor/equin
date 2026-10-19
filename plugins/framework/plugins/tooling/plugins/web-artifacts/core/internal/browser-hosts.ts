// Browser hosts: a plugin's `bin/browser-host.ts` — a Web Worker booting a
// portable server graph (`server-core`'s `bootBrowserHost`) — built into ONE
// artifact of the store and served through the import map as
// `@browser-host/<pluginPath>`, whose module exports `start(): Worker`.
//
// Unlike every other artifact, a host is a whole-graph bundle: import maps do
// not reach workers, so the worker inlines every module it loads, across ~50
// plugins, plus the npm packages (PGlite's wasm and data ride as assets). So
// its address cannot be "this plugin's own files". It is the content of every
// repo file the LAST build of the host loaded (the bundler's own module list,
// raw-imported SQL included), the listing of every directory holding one (so a
// new sibling — a new migration a glob would pick up — re-addresses it), the
// lockfile, and the builder identity. That list is recorded per host beside the
// store; a host never built, or whose list names a file that is gone, builds.
//
// The build is gated: a repo module that imports a Node builtin (vite's
// "externalized for browser compatibility") fails it — a dependency's own
// guarded platform branch (PGlite's `node:module`) does not.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Plugin as VitePlugin } from "vite";
import { webArtifactsDir } from "../../data-dirs";
import {
  BROWSER_HOST_SPECIFIER_PREFIX,
  isBrowserHostSpecifier,
} from "../browser-host-specifier";
import {
  artifactDirName,
  artifactTmpDir,
  hasArtifact,
  publishArtifact,
  touchArtifact,
  type ArtifactMeta,
} from "./store";

/** The host's emitted module: `export function start(): Worker`. */
export const BROWSER_HOST_FILE = "host.js";

/** Where a host's declaration lives inside its plugin. */
const HOST_ENTRY_REL = join("bin", "browser-host.ts");

const INPUTS_DIR = webArtifactsDir.file("browser-hosts");

/** One host of the fleet. */
export interface BrowserHostPlan {
  pluginPath: string;
  /** `@browser-host/<pluginPath>` */
  specifier: string;
  entryFile: string;
  /** The store dir of the current tree's host, when its inputs are known. */
  dirName: string | null;
  needsBuild: boolean;
}

/** The recorded inputs of a host's last build. */
interface HostInputs {
  /** Repo-relative files the bundler loaded. */
  files: string[];
}

const slugOf = (pluginPath: string) => pluginPath.split("/plugins/").join(".");

function inputsFile(pluginPath: string): string {
  return join(INPUTS_DIR, `${slugOf(pluginPath)}.json`);
}

function readInputs(pluginPath: string): HostInputs | null {
  const file = inputsFile(pluginPath);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as HostInputs;
}

/**
 * The address of a host over `files`: their contents, their directories'
 * listings, the lockfile and the builder identity. `null` when a listed file
 * is gone (the recorded list no longer describes this tree: build).
 */
function hostInputsHash(
  root: string,
  files: readonly string[],
  identityHash: string,
): string | null {
  const h = createHash("sha256");
  h.update(`identity\t${identityHash}\n`);
  h.update(`lock\t${readFileSync(join(root, "bun.lock"), "utf8")}\n`);
  const dirs = new Set<string>();
  for (const rel of [...files].sort()) {
    const abs = join(root, rel);
    if (!existsSync(abs)) return null;
    h.update(`file\t${rel}\t`);
    h.update(readFileSync(abs));
    h.update("\n");
    dirs.add(dirname(rel));
  }
  for (const dir of [...dirs].sort()) {
    const names = readdirSync(join(root, dir)).sort();
    h.update(`dir\t${dir}\t${names.join("\0")}\n`);
  }
  return h.digest("hex");
}

/**
 * The hosts the fleet carries — one per fleet plugin with a
 * `bin/browser-host.ts` — each with its current address when its inputs are
 * recorded and unchanged files still describe it.
 */
export function planBrowserHosts(opts: {
  root: string;
  pluginPaths: readonly string[];
  identityHash: string;
}): BrowserHostPlan[] {
  const plans: BrowserHostPlan[] = [];
  for (const pluginPath of opts.pluginPaths) {
    const entryFile = join(opts.root, "plugins", pluginPath, HOST_ENTRY_REL);
    if (!existsSync(entryFile)) continue;
    const inputs = readInputs(pluginPath);
    const hash =
      inputs === null
        ? null
        : hostInputsHash(opts.root, inputs.files, opts.identityHash);
    const dirName =
      hash === null
        ? null
        : artifactDirName(slugOf(pluginPath), "browser-host", hash);
    plans.push({
      pluginPath,
      specifier: `${BROWSER_HOST_SPECIFIER_PREFIX}${pluginPath}`,
      entryFile,
      dirName,
      needsBuild: dirName === null || !hasArtifact(dirName),
    });
  }
  return plans;
}

/** Records every repo module the worker bundle loads. */
function moduleRecorder(root: string): {
  plugin: VitePlugin;
  files: () => string[];
} {
  const files = new Set<string>();
  return {
    plugin: {
      name: "browser-host-inputs",
      generateBundle() {
        for (const id of this.getModuleIds()) {
          if (id.startsWith("\0")) continue;
          const path = id.split("?")[0]!;
          const rel = relative(root, path);
          if (rel.startsWith("..") || rel.split(sep).includes("node_modules"))
            continue;
          if (existsSync(path) && statSync(path).isFile()) files.add(rel);
        }
      },
    },
    files: () => [...files].sort(),
  };
}

const EXTERNALIZED_RE =
  /Module "([^"]+)" has been externalized for browser compatibility, imported by "([^"]+)"/;

/**
 * Build one host (or reuse it) and return its store dir. Logs the bundle size.
 */
export async function ensureBrowserHost(opts: {
  root: string;
  plan: BrowserHostPlan;
  identityHash: string;
  minify: boolean;
  log: (line: string) => void;
}): Promise<string> {
  const { root, plan } = opts;
  if (!plan.needsBuild && plan.dirName !== null) {
    touchArtifact(plan.dirName);
    return plan.dirName;
  }
  const { build: viteBuild, createLogger } = await import("vite");
  const slug = slugOf(plan.pluginPath);
  const tmpDir = artifactTmpDir(`${slug}.browser-host.pending`);
  // The page imports this module; vite's worker pass builds the worker it
  // names whole (no externals, no page preload helper), its assets beside it.
  const stub = `${tmpDir}.stub.js`;
  writeFileSync(
    stub,
    `export function start() {\n  return new Worker(new URL(${JSON.stringify(relative(dirname(stub), plan.entryFile))}, import.meta.url), { type: "module" });\n}\n`,
  );
  const recorder = moduleRecorder(root);
  const offenders: string[] = [];
  const logger = createLogger("warn");
  const warn = logger.warn.bind(logger);
  logger.warn = (msg, options) => {
    const m = EXTERNALIZED_RE.exec(msg);
    if (m !== null && !m[2]!.split(sep).includes("node_modules")) {
      offenders.push(`${m[1]} (imported by ${relative(root, m[2]!)})`);
    }
    warn(msg, options);
  };
  try {
    await viteBuild({
      configFile: false,
      logLevel: "warn",
      customLogger: logger,
      root,
      base: "./",
      resolve: { alias: { "@plugins": join(root, "plugins") } },
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      worker: {
        format: "es",
        plugins: () => [recorder.plugin],
        rollupOptions: {
          // A host's code may sit beside a scenario naming a browser host (its
          // own, even); a worker never starts one, so the import stays a dead
          // reference rollup drops with the code that holds it.
          external: isBrowserHostSpecifier,
          output: { inlineDynamicImports: true },
        },
      },
      build: {
        outDir: tmpDir,
        emptyOutDir: true,
        target: "esnext",
        minify: opts.minify ? "esbuild" : false,
        // PGlite's wasm and data are fetched by URL, never inlined.
        assetsInlineLimit: 0,
        modulePreload: false,
        reportCompressedSize: false,
        rollupOptions: {
          input: { host: stub },
          preserveEntrySignatures: "strict",
          output: { entryFileNames: BROWSER_HOST_FILE },
        },
      },
    });
    if (offenders.length > 0) {
      throw new Error(
        `the worker bundle reaches Node builtins from repo code — a browser host boots portable code only:\n  ${offenders.join("\n  ")}`,
      );
    }
    const files = recorder.files();
    if (files.length === 0) {
      throw new Error("the worker bundle recorded no repo module");
    }
    const hash = hostInputsHash(root, files, opts.identityHash);
    if (hash === null) {
      throw new Error("a module the worker bundle loaded vanished mid-build");
    }
    const dirName = artifactDirName(slug, "browser-host", hash);
    let bytes = 0;
    for (const f of readdirSync(tmpDir, { recursive: true }) as string[]) {
      const st = statSync(join(tmpDir, f));
      if (st.isFile()) bytes += st.size;
    }
    const meta: ArtifactMeta = {
      specifier: plan.specifier,
      kind: "browser-host",
      pluginPath: plan.pluginPath,
      inputsHash: hash,
      // The page imports nothing from it but `start`; the worker is inlined.
      staticImportsByFile: { [BROWSER_HOST_FILE]: [] },
      dynamicImports: [],
      builtAtMs: Date.now(),
    };
    publishArtifact(dirName, tmpDir, meta);
    mkdirSync(INPUTS_DIR, { recursive: true });
    writeFileSync(
      inputsFile(plan.pluginPath),
      JSON.stringify({ files } satisfies HostInputs, null, 2),
    );
    opts.log(
      `browser host ${plan.pluginPath}: ${files.length} repo modules, ${(bytes / 1_048_576).toFixed(1)} MB (${dirName})`,
    );
    return dirName;
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(
      `browser host build failed for ${plan.pluginPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    rmSync(stub, { force: true });
  }
}
