// Browser hosts: a plugin's `bin/browser-host.ts` — a Web Worker booting a
// portable server graph (`server-core`'s `bootBrowserHost`). The worker's code
// is NOT here: it is the same per-plugin artifacts the page loads (one per
// `server` barrel, the page's own `core` barrels, the vendor set), planned by
// `planHostClosure` and reached through the worker link tree
// (`worker-link.ts`), so an edit costs the one artifact it touches.
//
// What this module builds is the host's page-side artifact, served through the
// import map as `@browser-host/<pluginPath>`:
//   - `host.js`: `start(): Worker`, starting the worker from its entry's
//     import-map specifier (`@browser-host-worker/<pluginPath>`, mapped to the
//     entry artifact inside the dist's worker tree), and `serviceWorkerUrl`;
//   - `frames-sw.js`: the frame-serving Service Worker
//     (`framework/browser-server`'s `web/frames-sw.ts`), a classic script (no
//     imports), so bundled whole. Its address is the content of every repo file
//     a build of it loaded, their directories' listings and glob roots, the
//     lockfile and the builder identity. That list is only known after a
//     build, so each build records it INSIDE the artifact dir it addresses
//     (`inputs.json`: immutable, pruned with it). Planning asks every stored
//     build of the host, most recently used first, whether this tree still
//     hashes to its recorded address: the first that does is this tree's host;
//     none does → build. No record is shared mutable state, so a build in one
//     checkout cannot move another's address (a per-host "latest" record did:
//     whichever checkout built last overwrote it, and every other checkout's
//     `map-in-sync` recomputed its address from a foreign file list). It is a
//     few modules, not the server graph.
//
// The build is gated: a repo module that imports a Node builtin (vite's
// "externalized for browser compatibility") fails it.

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Plugin as VitePlugin } from "vite";
import {
  BROWSER_HOST_SPECIFIER_PREFIX,
  BROWSER_HOST_WORKER_SPECIFIER_PREFIX,
} from "../browser-host-specifier";
import { globRootsOf } from "./own-files";
import {
  artifactDirName,
  artifactStorePath,
  artifactTmpDir,
  hasArtifact,
  listArtifacts,
  publishArtifact,
  touchArtifact,
  type ArtifactMeta,
} from "./store";

/** The host's page-side module: `export function start(): Worker`. */
export const BROWSER_HOST_FILE = "host.js";

/** The host's frame-serving Service Worker script, beside its module. */
const FRAMES_SW_FILE = "frames-sw.js";

/**
 * The frame-serving Service Worker every host carries. One generic script:
 * vite bundles no `navigator.serviceWorker.register(new URL(…))`, so the host
 * build bundles it itself (a second pass, below), whole — import maps do not
 * reach it.
 */
const FRAMES_SW_ENTRY_REL =
  "plugins/framework/plugins/browser-server/web/frames-sw.ts";

/** Where a host's declaration lives inside its plugin. */
const HOST_ENTRY_REL = join("bin", "browser-host.ts");

/**
 * A host's input record, published INSIDE its store dir beside `meta.json`:
 * written once with the artifact, never rewritten, pruned with it. There is no
 * per-host "latest" record — every checkout finds its own address by asking
 * each recorded address whether this tree still hashes to it.
 */
const HOST_INPUTS_FILE = "inputs.json";

/** One host of the fleet. */
export interface BrowserHostPlan {
  pluginPath: string;
  /** The `host.js` source: part of the host's address. */
  hostSource: string;
  /** `@browser-host/<pluginPath>` */
  specifier: string;
  entryFile: string;
  /** The store dir of the current tree's host, when one is stored. */
  dirName: string | null;
  needsBuild: boolean;
}

/** The inputs one build of a host loaded. */
export interface HostInputs {
  /** Repo-relative files the bundler loaded. */
  files: string[];
  /**
   * Repo-relative static bases of the `import.meta.glob` patterns those files
   * hold, listed recursively by the address.
   */
  globRoots: string[];
}

/** {@link HostInputs} as recorded under the address they hash to. */
export interface HostInputsRecord extends HostInputs {
  inputsHash: string;
}

const slugOf = (pluginPath: string) => pluginPath.split("/plugins/").join(".");

/** The import-map specifier of a host's worker entry. */
export function hostWorkerSpecifier(pluginPath: string): string {
  return `${BROWSER_HOST_WORKER_SPECIFIER_PREFIX}${pluginPath}`;
}

/**
 * The host's page-side module. It starts the worker from its entry's
 * import-map specifier (`import.meta.resolve`), so this source never changes
 * with the worker's code: the map does.
 */
export function hostModuleSource(pluginPath: string): string {
  return (
    `export function start() {\n  return new Worker(import.meta.resolve(${JSON.stringify(hostWorkerSpecifier(pluginPath))}), { type: "module" });\n}\n` +
    `export const serviceWorkerUrl = import.meta.url.replace(/[^/]*$/, ${JSON.stringify(FRAMES_SW_FILE)});\n`
  );
}

/**
 * The address of a host over `inputs`: the files' contents, their
 * directories' listings, each glob root's recursive listing, the lockfile and
 * the builder identity. `null` when a listed file is gone (the list does not
 * describe this tree). Reads are memoized per hasher, so asking it about many
 * recorded lists (one per stored build) reads each file once.
 */
export function hostInputsHasher(
  root: string,
  identityHash: string,
): (inputs: HostInputs) => string | null {
  const digest = (bytes: Buffer | string) =>
    createHash("sha256").update(bytes).digest("hex");
  const fileDigests = new Map<string, string | null>();
  const dirListings = new Map<string, string>();
  const globListings = new Map<string, string>();
  let lockDigest: string | null = null;
  const fileDigest = (rel: string): string | null => {
    let d = fileDigests.get(rel);
    if (d === undefined) {
      const abs = join(root, rel);
      d = existsSync(abs) ? digest(readFileSync(abs)) : null;
      fileDigests.set(rel, d);
    }
    return d;
  };
  const dirListing = (dir: string): string => {
    let l = dirListings.get(dir);
    if (l === undefined) {
      l = readdirSync(join(root, dir)).sort().join("\0");
      dirListings.set(dir, l);
    }
    return l;
  };
  const globListing = (rel: string): string => {
    let l = globListings.get(rel);
    if (l === undefined) {
      const abs = join(root, rel);
      l = existsSync(abs)
        ? (readdirSync(abs, { recursive: true }) as string[])
            .map((n) => n.split(sep).join("/"))
            .sort()
            .join("\0")
        : "-";
      globListings.set(rel, l);
    }
    return l;
  };
  return ({ files, globRoots }) => {
    lockDigest ??= digest(readFileSync(join(root, "bun.lock")));
    const h = createHash("sha256");
    h.update(`identity\t${identityHash}\n`);
    h.update(`lock\t${lockDigest}\n`);
    const dirs = new Set<string>();
    for (const rel of [...files].sort()) {
      const d = fileDigest(rel);
      if (d === null) return null;
      h.update(`file\t${rel}\t${d}\n`);
      dirs.add(dirname(rel));
    }
    for (const dir of [...dirs].sort()) {
      h.update(`dir\t${dir}\t${dirListing(dir)}\n`);
    }
    for (const rel of [...globRoots].sort()) {
      h.update(`globroot\t${rel}\t${globListing(rel)}\n`);
    }
    return h.digest("hex");
  };
}

/** One-shot {@link hostInputsHasher}. */
export function hostInputsHash(
  root: string,
  inputs: HostInputs,
  identityHash: string,
): string | null {
  return hostInputsHasher(root, identityHash)(inputs);
}

/**
 * The first record this tree still hashes to — its own recorded address —
 * or `null` when none does (the host builds). A record matches exactly when
 * every input its build loaded is unchanged here, so the build of this tree
 * would load the same graph and land on the same address; which checkout
 * wrote it, or what was built since, does not matter.
 */
export function matchHostRecord<R extends HostInputsRecord>(
  records: Iterable<R>,
  hash: (inputs: HostInputs) => string | null,
): R | null {
  for (const record of records) {
    if (hash(record) === record.inputsHash) return record;
  }
  return null;
}

/** The input records of every stored build of a host, most recently used first. */
function* storedHostRecords(
  pluginPath: string,
): Generator<HostInputsRecord & { dirName: string }> {
  const slug = slugOf(pluginPath);
  for (const dirName of listArtifacts(`${slug}.browser-host.`)) {
    const file = join(artifactStorePath(dirName), HOST_INPUTS_FILE);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // No record: a dir published before records moved under the address
      // (never matchable; ages out with the store), or one another checkout's
      // prune removed after listArtifacts snapshotted the store.
      continue;
    }
    const record = JSON.parse(text) as HostInputsRecord;
    if (artifactDirName(slug, "browser-host", record.inputsHash) !== dirName) {
      throw new Error(
        `browser host record ${file} names address ${record.inputsHash}, not its own dir ${dirName}`,
      );
    }
    yield { ...record, dirName };
  }
}

/** The builder identity, bound to the host module's source. */
function hostIdentity(identityHash: string, hostSource: string): string {
  return createHash("sha256")
    .update(`${identityHash}\n${hostSource}`)
    .digest("hex");
}

/**
 * The hosts the fleet carries — one per fleet plugin with a
 * `bin/browser-host.ts` — each at the stored address whose recorded inputs this
 * tree still hashes to, or to build when none does.
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
    const hostSource = hostModuleSource(pluginPath);
    const match = matchHostRecord(
      storedHostRecords(pluginPath),
      hostInputsHasher(opts.root, hostIdentity(opts.identityHash, hostSource)),
    );
    const dirName = match?.dirName ?? null;
    plans.push({
      pluginPath,
      hostSource,
      specifier: `${BROWSER_HOST_SPECIFIER_PREFIX}${pluginPath}`,
      entryFile,
      dirName,
      needsBuild: dirName === null,
    });
  }
  return plans;
}

/** Records every repo module the worker bundle loads, and the static bases of their globs. */
function moduleRecorder(root: string): {
  plugin: VitePlugin;
  inputs: () => HostInputs;
} {
  const files = new Set<string>();
  const globRoots = new Set<string>();
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
          if (!existsSync(path) || !statSync(path).isFile()) continue;
          files.add(rel);
          if (!/\.[cm]?[jt]sx?$/.test(path)) continue;
          const source = readFileSync(path, "utf8");
          if (!source.includes("import.meta.glob")) continue;
          for (const g of globRootsOf(root, rel, source)) globRoots.add(g);
        }
      },
    },
    inputs: () => ({
      files: [...files].sort(),
      globRoots: [...globRoots].sort(),
    }),
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
  /** Pin an entry into the build's lease before it is read or published (`lease.ts`). */
  pin: (paths: readonly string[]) => Promise<void>;
}): Promise<string> {
  const { root, plan } = opts;
  if (!plan.needsBuild && plan.dirName !== null) {
    await opts.pin([artifactStorePath(plan.dirName)]);
    // Pinned, so it stays if it is still there; a prune that ran since planning
    // may have taken it, and then the host builds again.
    if (hasArtifact(plan.dirName)) {
      touchArtifact(plan.dirName);
      return plan.dirName;
    }
  }
  const { build: viteBuild, createLogger } = await import("vite");
  const slug = slugOf(plan.pluginPath);
  const tmpDir = artifactTmpDir(`${slug}.browser-host.pending`);
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
    // The frame-serving Service Worker, into the same dir: a classic script
    // (a module Service Worker is not supported everywhere), bundled whole.
    // Its modules are recorded too, so an edit to it re-addresses the host.
    await viteBuild({
      configFile: false,
      logLevel: "warn",
      customLogger: logger,
      root,
      publicDir: false,
      resolve: { alias: { "@plugins": join(root, "plugins") } },
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      plugins: [recorder.plugin],
      build: {
        outDir: tmpDir,
        emptyOutDir: true,
        target: "esnext",
        minify: opts.minify ? "oxc" : false,
        modulePreload: false,
        reportCompressedSize: false,
        rolldownOptions: {
          input: { "frames-sw": join(root, FRAMES_SW_ENTRY_REL) },
          output: {
            format: "iife",
            entryFileNames: FRAMES_SW_FILE,
            inlineDynamicImports: true,
          },
        },
      },
    });
    if (offenders.length > 0) {
      throw new Error(
        `the frame-serving Service Worker reaches Node builtins from repo code:\n  ${offenders.join("\n  ")}`,
      );
    }
    writeFileSync(join(tmpDir, BROWSER_HOST_FILE), plan.hostSource);
    const inputs = recorder.inputs();
    const { files } = inputs;
    if (files.length === 0) {
      throw new Error("the Service Worker build recorded no repo module");
    }
    const hash = hostInputsHash(
      root,
      inputs,
      hostIdentity(opts.identityHash, plan.hostSource),
    );
    if (hash === null) {
      throw new Error(
        "a module the Service Worker build loaded vanished mid-build",
      );
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
      // `host.js` imports nothing: the worker's modules are the link tree's,
      // started by URL, and the Service Worker is a classic script.
      staticImportsByFile: { [BROWSER_HOST_FILE]: [] },
      dynamicImports: [],
      // A worker draws nothing: its classes are not the page's.
      tailwindCandidates: [],
      builtAtMs: Date.now(),
    };
    // The record rides inside the artifact dir, published with it: immutable,
    // keyed by the address it hashes to, gone when the artifact is pruned.
    writeFileSync(
      join(tmpDir, HOST_INPUTS_FILE),
      JSON.stringify({
        inputsHash: hash,
        ...inputs,
      } satisfies HostInputsRecord),
    );
    await opts.pin([artifactStorePath(dirName)]);
    await publishArtifact(dirName, tmpDir, meta);
    opts.log(
      `browser host ${plan.pluginPath}: host module + Service Worker (${files.length} repo modules, ${(bytes / 1024).toFixed(0)} KB) (${dirName})`,
    );
    return dirName;
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(
      `browser host build failed for ${plan.pluginPath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
