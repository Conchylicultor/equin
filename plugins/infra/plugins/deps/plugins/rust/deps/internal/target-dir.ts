import { mkdir, rename, rm } from "node:fs/promises";
import {
  exists,
  readdir,
  readFile,
} from "@plugins/packages/plugins/timed-fs/core";
import { waitForFlock } from "@plugins/packages/plugins/flock/core";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { BuildContext } from "@plugins/infra/plugins/deps/plugins/build/deps";
import { cargoTargetDir } from "../../data-dirs";

/**
 * The shared target cache's layout. A crate's warm target dir is
 * `crates/<key>`, and it is only ever REPLACED whole, never written into by a
 * build: each build compiles in its own copy, `staging/<key>.<pid>.<nonce>`,
 * which becomes `crates/<key>` only once cargo succeeded. A compile that is
 * killed (SIGKILL, a sandbox refusing a rename, the machine going down) or
 * fails leaves its copy behind and the warm dir as it was, so a half-written
 * target dir can never reach the next build.
 *
 * Before this layout, builds wrote straight into `<key>` at the cache root; a
 * killed rustc left it half-written and every later build failed with errors
 * unrelated to the code until someone deleted it by hand. `crates/` is a new
 * name on purpose, so a dir that old layout may have poisoned is never read
 * again: it is deleted when the crate's first build under this layout
 * publishes.
 */
const CRATES = "crates";
const STAGING = "staging";
const CHECKS = "checks";
const LOCKS = "locks";

/** The key a crate's dirs are named by: its repo path with `/` as `__`. */
function crateKey(crate: string): string {
  return crate.replaceAll("/", "__");
}

/**
 * The warm `target/` dir of one crate in the shared `cargo-target` cache —
 * what the last successful build left. Nothing writes into it: a build
 * compiles in a clone ({@link withStagedTargetDir}).
 */
export async function crateTargetDir(crate: string): Promise<string> {
  return join(await cargoTargetDir.ensure(), CRATES, crateKey(crate));
}

/**
 * A target dir of one crate for cargo commands that only check it (the cargo
 * updater's `cargo check` smoke), apart from the warm dir: a check killed
 * part-way can only spoil later checks, and a build publishing mid-check
 * cannot move the dir out from under it.
 */
export async function crateCheckTargetDir(crate: string): Promise<string> {
  return join(await cargoTargetDir.ensure(), CHECKS, crateKey(crate));
}

/**
 * Run `build` with `CARGO_TARGET_DIR` a private copy of the crate's warm
 * target dir, and make that copy the warm dir only if `build` resolves.
 *
 * - **Copy**: a copy-on-write clone (APFS `clonefile` through `cp -c`, a
 *   reflink on Linux where the file system has them), mtimes kept, so cargo's
 *   fingerprints of the crate's dependencies still read as fresh and the build
 *   stays incremental. No warm dir yet: an empty one, a cold build.
 * - **The crate's own units are always rebuilt**: their fingerprints are
 *   removed from the copy. Cargo judges a path crate fresh by mtimes, and the
 *   warm dir may come from another checkout whose sources are NEWER than this
 *   one's while different — kept, that fingerprint would hand this checkout the
 *   other one's binary. A build runs only when the crate's identity changed
 *   (its files, or rustc), so the crate recompiles anyway.
 * - **Publish**: the warm dir is renamed aside, the copy renamed into its
 *   place, the old one deleted. Two builds of one crate racing (two checkouts
 *   with different sources hold different deps locks) each publish whole; the
 *   later one wins, and one that loses the rename just discards its copy.
 *   Clone and publish hold the crate's lock file (`locks/<key>.lock`), so a
 *   clone never reads a warm dir another build is replacing; cargo itself runs
 *   outside it.
 * - **Failure**: the copy is deleted and the error rethrown. One whose process
 *   died before it could delete it is swept by the next build of any crate
 *   (its pid, in its name, no longer runs).
 */
export async function withStagedTargetDir<T>(
  ctx: Pick<BuildContext, "run" | "root">,
  crate: string,
  build: (targetDir: string) => Promise<T>,
): Promise<T> {
  const cache = await cargoTargetDir.ensure();
  const key = crateKey(crate);
  const warm = join(cache, CRATES, key);
  const stagingRoot = join(cache, STAGING);
  const lock = join(cache, LOCKS, `${key}.lock`);
  await mkdir(join(cache, CRATES), { recursive: true });
  await mkdir(join(cache, LOCKS), { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await sweepAbandoned(stagingRoot);

  const staged = join(stagingRoot, stagingName(key));
  let result: T;
  try {
    await underLock(lock, async () => {
      if (await exists(warm)) {
        await ctx.run(cloneArgv(warm, staged), {
          cwd: ctx.root,
          env: process.env,
          timeoutMs: CLONE_TIMEOUT_MS,
        });
      } else {
        await mkdir(staged);
      }
    });
    await forgetOwnUnits(staged, await packageName(join(ctx.root, crate)));
    result = await build(staged);
  } catch (err) {
    await rm(staged, { recursive: true, force: true });
    throw err;
  }
  await underLock(lock, () => publish(staged, warm, stagingRoot, key));
  // The pre-`crates/` dir of this crate, possibly half-written: gone once a
  // build under this layout has a warm dir to replace it.
  await rm(join(cache, key), { recursive: true, force: true });
  return result;
}

async function underLock(path: string, fn: () => Promise<void>): Promise<void> {
  const held = await waitForFlock(path);
  try {
    await fn();
  } finally {
    await held.release();
  }
}

/** The `[package] name` of the crate at `dir` — what cargo names its units by. */
async function packageName(dir: string): Promise<string> {
  const manifest = join(dir, "Cargo.toml");
  let section = "";
  for (const line of (await readFile(manifest, "utf8")).split("\n")) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header?.[1] !== undefined) {
      section = header[1].trim();
      continue;
    }
    const name = /^\s*name\s*=\s*"([A-Za-z0-9_-]+)"/.exec(line);
    if (section === "package" && name?.[1] !== undefined) return name[1];
  }
  throw new Error(`no [package] name in ${manifest}`);
}

/**
 * Remove what makes cargo call `pkg`'s own units (lib, bins, build script)
 * fresh in a release target dir, so it rebuilds them. Two layouts: cargo
 * ≥ 1.100 keeps each package's units under `release/build/<pkg>/<hash>/`
 * (fingerprints included); before, fingerprints were
 * `release/.fingerprint/<pkg>-<16 hex>`. A package name is `[A-Za-z0-9_-]+`
 * (as {@link packageName} reads it): no regex escaping.
 */
async function forgetOwnUnits(targetDir: string, pkg: string): Promise<void> {
  const release = join(targetDir, "release");
  await rm(join(release, "build", pkg), { recursive: true, force: true });
  const fingerprints = join(release, ".fingerprint");
  if (!(await exists(fingerprints))) return;
  const own = new RegExp(`^${pkg}-[0-9a-f]{16}$`);
  for (const name of await readdir(fingerprints)) {
    if (own.test(name)) await rm(join(fingerprints, name), { recursive: true });
  }
}

const MINUTE = 60_000;
/** A clone is metadata only, but a large target dir is thousands of files. */
const CLONE_TIMEOUT_MS = 10 * MINUTE;

/** `<key>.<pid>.<nonce>`: the pid is what {@link sweepAbandoned} reads back. */
function stagingName(key: string): string {
  return `${key}.${process.pid}.${randomBytes(4).toString("hex")}`;
}

function cloneArgv(from: string, to: string): string[] {
  return process.platform === "darwin"
    ? ["cp", "-c", "-R", "-p", from, to]
    : ["cp", "-a", "--reflink=auto", from, to];
}

async function publish(
  staged: string,
  warm: string,
  stagingRoot: string,
  key: string,
): Promise<void> {
  const retired = join(stagingRoot, stagingName(key));
  try {
    await rename(warm, retired);
  } catch (err) {
    if (!isCode(err, "ENOENT")) throw err;
  }
  try {
    await rename(staged, warm);
  } catch (err) {
    // Another build of the crate published between our two renames: its dir
    // is as good as ours, keep it.
    if (!isCode(err, "ENOTEMPTY") && !isCode(err, "EEXIST")) throw err;
    await rm(staged, { recursive: true, force: true });
  }
  await rm(retired, { recursive: true, force: true });
}

/** Delete the staging dirs whose build process is gone. */
async function sweepAbandoned(stagingRoot: string): Promise<void> {
  for (const name of await readdir(stagingRoot)) {
    const pid = Number(name.split(".").at(-2));
    if (!Number.isInteger(pid) || pid <= 0 || isAlive(pid)) continue;
    await rm(join(stagingRoot, name), { recursive: true, force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, someone else's.
    if (isCode(err, "EPERM")) return true;
    if (isCode(err, "ESRCH")) return false;
    throw err;
  }
}

function isCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}
