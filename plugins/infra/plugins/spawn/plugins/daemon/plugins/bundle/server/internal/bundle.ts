import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { BunPlugin } from "bun";
import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  exists,
  readdir,
  readFile,
  realpath,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  BUNDLE_DIR_SUFFIX,
  bundledScriptName,
  REPO_ROOT,
  REPO_ROOT_MODULE,
} from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { flockTry, flockTryShared } from "@plugins/packages/plugins/flock/core";
import {
  openOwnedFd,
  type OwnedFd,
} from "@plugins/packages/plugins/owned-fd/core";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import {
  holdDep,
  linkSealedDep,
  type Ready,
} from "@plugins/infra/plugins/deps/deps";

/** What to bundle, and where its bundles live. */
export interface DaemonBundleSpec {
  /**
   * The checkout to bundle from: its `tsconfig` resolves `@plugins/…`, its
   * `node_modules` the npm packages, and every `scriptPath` literal is
   * relative to it. Default: the checkout this code runs from.
   */
  root?: AppPath;
  /** The daemon's entry, repo-relative (`plugins/…/bin/host.ts`). */
  entry: string;
  /**
   * npm packages left out of the bundle and cloned beside it, each with the
   * evidence why it cannot be inlined (a package that loads its own files by
   * path, a native addon). Their dependencies come along. Everything else —
   * repo code and every other package — is inlined.
   */
  external: Readonly<Record<string, string>>;
  /**
   * Dependency installs the bundle reads as sealed (`deps`' `readyNow` from
   * inside it answers these, deriving nothing from a checkout): linked, not
   * copied (`linkSealedDep`).
   */
  seal?: readonly Ready[];
  /** This daemon's bundle home: one `<hash>.bundle` per distinct content. */
  dir: AppPath;
}

/** A bundle, held: nothing reclaims it while `inUse` (or a copy) is open. */
export interface DaemonBundle {
  /** Content hash: the emitted files, the externals' versions, the seals. */
  hash: string;
  /** `<spec.dir>/<hash>.bundle` — the bundled code's `REPO_ROOT`. */
  dir: AppPath;
  /** The entry's bundled `.js`, at the entry's repo-relative path inside. */
  entry: AppPath;
  /**
   * A SHARED flock on the bundle's in-use lock. Hand it to the process run
   * from the bundle (`launchDetached({ holdFds: [inUse] })` — the process then
   * holds it for life), then close it here.
   */
  inUse: OwnedFd;
  /** `false` when an identical bundle already existed and was reused. */
  made: boolean;
  /** Bundle names this call reclaimed (unheld, other content). */
  reclaimed: string[];
  /** Wall time: the bundler's builds, and the whole call. */
  ms: { build: number; total: number };
}

const LOCK_FILE = "in-use.lock";
const MANIFEST_FILE = "bundle.json";
const STAGING_PREFIX = ".staging-";
const TRASH_PREFIX = ".trash-";
/** Rounds of "bundle, find the scripts it runs, bundle those too". */
const MAX_ROUNDS = 8;
/** Holding a just-found bundle races its reclaim; a few retries settle it. */
const MAX_HOLD_ATTEMPTS = 3;
const CLONE_TIMEOUT_MS = 2 * 60_000;

/**
 * Bundle a detached daemon's entry into a self-contained directory and hold
 * it: one JS file per entry (repo code and pure-JS packages inlined), the
 * scripts it runs by path (`scriptPath` literals, bundled beside it at their
 * repo-relative paths, recursively), the `external` packages cloned into its
 * `node_modules`, and the `seal`ed dependency installs. The process run from
 * it reads nothing from the checkout it was made from.
 *
 * Content-addressed: `<dir>/<hash>.bundle`, made in a staging dir and renamed
 * into place; an existing one is reused, and two concurrent makers of the
 * same content both end up holding the one that won. Every call also reclaims
 * the bundles in `dir` that nothing holds.
 *
 * Refuses (throws) a bundle that would still reach the checkout: a module
 * other than `repo-root` reading its own location (`import.meta.dir`,
 * `__dirname`, …), a `scriptPath` call whose argument is not a literal, a
 * script or external that does not exist.
 */
export async function bundleDaemon(
  spec: DaemonBundleSpec,
): Promise<DaemonBundle> {
  const t0 = performance.now();
  const root = spec.root ?? REPO_ROOT;
  await mkdir(spec.dir, { recursive: true });
  const built = await bundleEntry(root, spec.entry, Object.keys(spec.external));
  const buildMs = performance.now() - t0;
  const externals = await resolveExternals(
    root,
    spec.entry,
    Object.keys(spec.external),
  );
  const seals = spec.seal ?? [];
  const hash = await contentHash(built, externals, seals);
  const name = `${hash}${BUNDLE_DIR_SUFFIX}`;
  const final = joinAppPath(spec.dir, name);
  const entry = joinAppPath(final, bundledScriptName(spec.entry));

  let made = false;
  let held: OwnedFd | null = null;
  for (let attempt = 1; held === null; attempt++) {
    if (attempt > MAX_HOLD_ATTEMPTS) {
      throw new Error(
        `[daemon-bundle] could not hold ${final} after ${MAX_HOLD_ATTEMPTS} attempts: each time it was being reclaimed`,
      );
    }
    if (!(await exists(joinAppPath(final, MANIFEST_FILE)))) {
      made =
        (await stage(spec.dir, final, {
          hash,
          entry: spec.entry,
          built,
          externals,
          seals,
          buildMs,
        })) || made;
    }
    held = await tryHold(final);
  }
  // The seals are links into the host's install cache: hold each install
  // for as long as anything holds this bundle (its in-use lock), so a
  // Remove in Debug → Dependencies or a deps sweep cannot take the payload
  // from under the daemon running from it. Taken once the lock is held —
  // an unheld one reads as stale.
  try {
    for (const r of seals) {
      await holdDep(r, `bundle-${hash}`, {
        whileLocked: joinAppPath(final, LOCK_FILE),
      });
    }
  } catch (err) {
    held.close();
    throw err;
  }
  const reclaimed = await reclaimBundles(spec.dir, name);
  return {
    hash,
    dir: final,
    entry,
    inUse: held,
    made,
    reclaimed,
    ms: { build: buildMs, total: performance.now() - t0 },
  };
}

// ── Bundling ──────────────────────────────────────────────────────────────

interface Built {
  /** Emitted file, repo-relative → its bytes (bundled entries and scripts). */
  files: Map<string, Uint8Array>;
  /** Scripts run by path that are not TypeScript: copied as they are. */
  copied: Map<string, AppPath>;
}

/**
 * Bundle `entry` and, to a fixed point, every TypeScript script its closure
 * runs by path; each output lands at its source's repo-relative path (`.js`).
 */
async function bundleEntry(
  root: AppPath,
  entry: string,
  external: readonly string[],
): Promise<Built> {
  const entries = new Set([entry]);
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const scripts = new Set<string>();
    const result = await Bun.build({
      entrypoints: [...entries].map((e) => join(root, e)),
      root,
      target: "bun",
      format: "esm",
      // Section comments (`// <path>`) are what the location check reads.
      minify: false,
      external: external.flatMap((n) => [n, `${n}/*`]),
      naming: "[dir]/[name].[ext]",
      plugins: [scriptScanner(root, scripts)],
      throw: false,
    });
    if (!result.success) {
      throw new AggregateError(
        result.logs,
        `[daemon-bundle] bundling ${entry} failed: ${result.logs.map(String).join("\n")}`,
      );
    }
    const pending = [...scripts].filter(
      (s) => isTypeScript(s) && !entries.has(s),
    );
    if (pending.length > 0) {
      for (const s of pending) entries.add(s);
      continue;
    }
    const files = new Map<string, Uint8Array>();
    for (const out of result.outputs) {
      const rel = relative(".", out.path);
      files.set(rel, new Uint8Array(await out.arrayBuffer()));
    }
    for (const e of entries) {
      if (!files.has(bundledScriptName(e))) {
        throw new Error(
          `[daemon-bundle] the bundler emitted no ${bundledScriptName(e)} for ${e} (outputs: ${[...files.keys()].join(", ")})`,
        );
      }
    }
    // Both spellings of the checkout: a baked `__dirname` is the real path.
    const roots = [...new Set([root, await realpath(root)])];
    for (const [rel, bytes] of files) assertLocationFree(roots, rel, bytes);
    const copied = new Map<string, AppPath>();
    for (const s of scripts) {
      if (!isTypeScript(s)) copied.set(s, joinAppPath(root, s));
    }
    return { files, copied };
  }
  throw new Error(
    `[daemon-bundle] ${entry}: its scripts kept naming new scripts after ${MAX_ROUNDS} rounds`,
  );
}

function isTypeScript(rel: string): boolean {
  return bundledScriptName(rel) !== rel;
}

const SCRIPT_CALL = /(?<![\w$.])scriptPath\s*\(/g;
const SCRIPT_LITERAL = /^\s*(["'`])([^"'`\\$]+)\1\s*,?\s*\)/;

/**
 * Collect the `scriptPath("<repo-relative>")` literals of every repo module
 * the build loads. A call it cannot read is refused: the bundle would lack
 * the script it names.
 */
function scriptScanner(root: AppPath, into: Set<string>): BunPlugin {
  return {
    name: "daemon-bundle-scripts",
    setup(build) {
      build.onLoad({ filter: /\.(?:[cm]?ts|tsx)$/ }, async (args) => {
        const text = await readFile(args.path, "utf8");
        if (!args.path.split(sep).includes("node_modules")) {
          for (const m of text.matchAll(SCRIPT_CALL)) {
            const at = m.index;
            if (text.slice(Math.max(0, at - 9), at) === "function ") continue;
            const lit = SCRIPT_LITERAL.exec(text.slice(at + m[0].length));
            if (lit === null) {
              throw new Error(
                `[daemon-bundle] ${args.path}: a scriptPath(…) call whose argument is not a string literal — the bundle cannot know which script to carry`,
              );
            }
            const rel = lit[2]!;
            const abs = joinAppPath(root, rel);
            if (relative(root, abs).startsWith("..")) {
              throw new Error(
                `[daemon-bundle] ${args.path}: scriptPath("${rel}") leaves the checkout`,
              );
            }
            if (!(await exists(abs))) {
              throw new Error(
                `[daemon-bundle] ${args.path}: scriptPath("${rel}") names no file in ${root}`,
              );
            }
            into.add(rel);
          }
        }
        return {
          contents: text,
          loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
        };
      });
    },
  };
}

/** Reads of a module's own location — the thing a bundle cannot honour. */
const SELF_LOCATION =
  /\bimport\.meta\.(?:dir|dirname|url|path|file|filename|resolve|resolveSync)\b|(?<![\w$.])__(?:dirname|filename)\b/;
/** Bun's per-module section comment in an unminified bundle (its path relative to the bundler's working directory). */
const SECTION = /^\/\/ (\S+\.(?:[cm]?[jt]sx?|json))$/;

/**
 * In a bundle every module's `import.meta` / `__dirname` is the bundle
 * file's, so a path built from one points at a file the bundle does not
 * have — or, worse, silently back into the checkout. Only `repo-root` may
 * read its location (that is how it finds the bundle's root). Nor may any
 * line name the checkout's own absolute path.
 */
function assertLocationFree(
  roots: readonly string[],
  rel: string,
  bytes: Uint8Array,
): void {
  let section = "(bundle preamble)";
  const offenders: string[] = [];
  const lines = new TextDecoder().decode(bytes).split("\n");
  for (const line of lines) {
    const header = SECTION.exec(line);
    if (header) {
      section = header[1]!;
      continue;
    }
    // A path baked in at build time (Bun inlines a CommonJS module's
    // `__dirname` as its absolute directory) reaches the checkout directly.
    if (roots.some((r) => line.includes(r))) {
      offenders.push(
        `${section}: names the checkout: ${line.trim().slice(0, 160)}`,
      );
      continue;
    }
    // The header is relative to this process's working directory, which
    // need not be the checkout (a backend's is not).
    if (resolve(section).endsWith(`/${REPO_ROOT_MODULE}`)) continue;
    if (SELF_LOCATION.test(line)) {
      offenders.push(`${section}: ${line.trim().slice(0, 160)}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `[daemon-bundle] ${rel} would read a module's own location, which a bundle moves — name the file with scriptPath("<repo-relative>") or read it through REPO_ROOT, or leave its package external:\n  ${offenders.join("\n  ")}`,
    );
  }
}

// ── Externals ─────────────────────────────────────────────────────────────

interface External {
  name: string;
  version: string;
  /** The package's real directory in the checkout's install. */
  dir: string;
  /** What names this exact install: bun's store key, else the version. */
  key: string;
}

/**
 * Each external package, and transitively its dependencies, as the runtime
 * would resolve them: the `node_modules` walk from the importer's directory
 * (the entry's for an external, the package's own real directory for a
 * dependency — bun's isolated layout puts its dependencies beside it).
 */
async function resolveExternals(
  root: AppPath,
  entry: string,
  names: readonly string[],
): Promise<External[]> {
  const found = new Map<string, External>();
  const queue: { name: string; from: string; optional: boolean }[] = names.map(
    (name) => ({
      name,
      from: dirname(joinAppPath(root, entry)),
      optional: false,
    }),
  );
  while (queue.length > 0) {
    const { name, from, optional } = queue.shift()!;
    const dir = await packageDir(name, from);
    if (dir === null) {
      if (optional) continue;
      throw new Error(
        `[daemon-bundle] cannot resolve the external package ${name} from ${from}`,
      );
    }
    const seen = found.get(name);
    if (seen) {
      if (seen.dir !== dir) {
        throw new Error(
          `[daemon-bundle] two installs of ${name} are needed (${seen.dir}, ${dir}); a bundle's flat node_modules holds one`,
        );
      }
      continue;
    }
    const pkg = JSON.parse(
      await readFile(join(dir, "package.json"), "utf8"),
    ) as {
      version?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    if (!pkg.version) throw new Error(`${dir}/package.json names no version`);
    const parts = dir.split(sep);
    const at = parts.indexOf(".bun");
    const store = at >= 0 ? parts[at + 1] : undefined;
    found.set(name, {
      name,
      version: pkg.version,
      dir,
      key: store ?? `${name}@${pkg.version}`,
    });
    for (const dep of Object.keys(pkg.dependencies ?? {}))
      queue.push({ name: dep, from: dir, optional: false });
    for (const dep of Object.keys(pkg.optionalDependencies ?? {}))
      queue.push({ name: dep, from: dir, optional: true });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** `name`'s real directory from `from` upward, or null when nothing resolves. */
async function packageDir(name: string, from: string): Promise<string | null> {
  for (let dir = from; ; dir = dirname(dir)) {
    try {
      return dirname(
        await realpath(join(dir, "node_modules", name, "package.json")),
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }
    if (dirname(dir) === dir) return null;
  }
}

// ── Content address ───────────────────────────────────────────────────────

async function contentHash(
  built: Built,
  externals: readonly External[],
  seals: readonly Ready[],
): Promise<string> {
  const h = createHash("sha256");
  const part = (...xs: (string | Uint8Array)[]): void => {
    for (const x of xs) {
      h.update(x);
      h.update("\0");
    }
  };
  part("daemon-bundle/1");
  for (const rel of [...built.files.keys()].sort())
    part("file", rel, built.files.get(rel)!);
  // A copied script's BYTES, not just its name: an edit to it is new content
  // (a bundle reused under the old hash would run the old script).
  for (const rel of [...built.copied.keys()].sort())
    part("copied", rel, await readFile(built.copied.get(rel)!));
  for (const e of externals) part("external", e.name, e.key);
  for (const r of [...seals].sort((a, b) => a.dep.id.localeCompare(b.dep.id)))
    part("seal", r.dep.id, r.identity, r.dir);
  return h.digest("hex").slice(0, 16);
}

// ── Staging, holding, reclaiming ──────────────────────────────────────────

/**
 * Make the bundle in a staging dir and rename it into place. `false` when a
 * concurrent maker's rename won (its bundle is the same content).
 */
async function stage(
  home: AppPath,
  final: AppPath,
  b: {
    hash: string;
    entry: string;
    built: Built;
    externals: readonly External[];
    seals: readonly Ready[];
    buildMs: number;
  },
): Promise<boolean> {
  const staging = joinAppPath(
    home,
    `${STAGING_PREFIX}${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  try {
    for (const [rel, bytes] of b.built.files) {
      const path = joinAppPath(staging, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    for (const [rel, source] of b.built.copied) {
      const path = joinAppPath(staging, rel);
      await mkdir(dirname(path), { recursive: true });
      await clone(source, path);
    }
    for (const e of b.externals) {
      const path = joinAppPath(staging, "node_modules", e.name);
      await mkdir(dirname(path), { recursive: true });
      await clone(e.dir, path);
    }
    for (const r of b.seals) await linkSealedDep(r, staging);
    await writeFile(joinAppPath(staging, LOCK_FILE), "");
    await writeFile(
      joinAppPath(staging, MANIFEST_FILE),
      `${JSON.stringify(
        {
          hash: b.hash,
          entry: b.entry,
          madeAt: new Date().toISOString(),
          madeBy: process.pid,
          buildMs: Math.round(b.buildMs),
          files: [...b.built.files.keys(), ...b.built.copied.keys()].sort(),
          externals: b.externals.map((e) => `${e.name}@${e.version}`),
          seals: b.seals.map((r) => `${r.dep.id}@${r.identity}`),
        },
        null,
        2,
      )}\n`,
    );
    try {
      await rename(staging, final);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST") throw err;
      return false;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** A copy that shares blocks where the filesystem can (APFS clones). */
async function clone(from: string, to: string): Promise<void> {
  const argv =
    process.platform === "darwin"
      ? ["cp", "-cR", from, to]
      : ["cp", "-R", "--reflink=auto", from, to];
  await spawnExpectOk(argv, { timeoutMs: CLONE_TIMEOUT_MS });
}

/**
 * A shared hold on `final`'s in-use lock, or null when it is gone or being
 * reclaimed (a reclaimer holds the lock exclusively while it renames the
 * bundle away, so a hold taken after that finds the manifest missing).
 */
async function tryHold(final: AppPath): Promise<OwnedFd | null> {
  let fd: OwnedFd;
  try {
    fd = await openOwnedFd(joinAppPath(final, LOCK_FILE), "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (
    flockTryShared(fd.fd) &&
    (await exists(joinAppPath(final, MANIFEST_FILE)))
  )
    return fd;
  fd.close();
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw err;
  }
}

/** The pid a staging or trash dir was named with. */
function ownerPid(name: string, prefix: string): number {
  const pid = Number.parseInt(name.slice(prefix.length), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`[daemon-bundle] ${name} names no pid after ${prefix}`);
  }
  return pid;
}

/**
 * Delete every bundle in `home` but `keep` that nothing holds (an exclusive
 * try on its in-use lock succeeds only when no process run from it, and no
 * launcher about to run one, holds it shared), and what dead makers left.
 */
async function reclaimBundles(home: AppPath, keep: string): Promise<string[]> {
  const reclaimed: string[] = [];
  for (const name of await readdir(home)) {
    const path = joinAppPath(home, name);
    if (name.startsWith(STAGING_PREFIX) || name.startsWith(TRASH_PREFIX)) {
      const prefix = name.startsWith(STAGING_PREFIX)
        ? STAGING_PREFIX
        : TRASH_PREFIX;
      if (!pidAlive(ownerPid(name, prefix)))
        await rm(path, { recursive: true, force: true });
      continue;
    }
    if (!name.endsWith(BUNDLE_DIR_SUFFIX) || name === keep) continue;
    let fd: OwnedFd;
    try {
      fd = await openOwnedFd(joinAppPath(path, LOCK_FILE), "r");
    } catch (err) {
      // Mid-delete by another reclaimer.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const trash = joinAppPath(
      home,
      `${TRASH_PREFIX}${process.pid}-${randomUUID().slice(0, 8)}`,
    );
    try {
      if (!flockTry(fd.fd)) continue;
      await rename(path, trash);
    } finally {
      fd.close();
    }
    await rm(trash, { recursive: true, force: true });
    reclaimed.push(name);
  }
  return reclaimed;
}
