import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import { constants, type Stats } from "node:fs";
import {
  copyFile,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  readdir,
  readlink,
  realpath,
  stat,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// macOS names a process by the FILE it executed (`p_comm`, what Activity
// Monitor and `ps -c` show), so every Bun process reads `bun`. `process.title`
// changes nothing there (measured, bun 1.4.4). An APFS clone is a copy that
// shares the source's blocks: run through it, the process is listed by its
// name, at no disk cost. Bun reads its own file name only for `bun`, `bunx` and
// `node`, so a name starting with the product name runs plain Bun.
//
// A CLONE, NEVER A HARDLINK. A hardlink is the same inode under another name,
// and at exec macOS's malware scan (syspolicyd) asks the kernel for the
// executable's path — which, for an inode with many names, can be ANY of them,
// including one just renamed away or deleted. syspolicyd then cannot read it
// (ENOENT), calls it a "Malware rejection" and SIGKILLs the process inside
// exec, before it prints a byte. With every named Bun on the machine one inode
// of ~800 churning names, that killed a `./equin install` and a `./equin push`
// (2026-11-03). Measured: a stable hardlink exec'd while siblings are made and
// deleted was killed 7 times in 2,600 runs, a stable clone 0 in 2,300 — and a
// clone's only name is the one exec'd. A fresh name costs one ~1.1 s scan on
// its first exec either way, so a current clone is never re-made.

export type NamedBinary =
  | { kind: "cloned"; path: AppPath }
  /** The filesystem refused the clone (not APFS, another volume, no permission): run `bin` itself. */
  | { kind: "refused"; code: string };

/**
 * A staging name no other call in this process holds: the calls are async, so
 * two clones into one directory (an agent's claude and bun) can be in flight
 * at once, and a pid alone would hand them the same file.
 */
let stagingSeq = 0;
function stagingSuffix(): string {
  stagingSeq += 1;
  return `${String(process.pid)}.${String(stagingSeq)}.tmp`;
}

/** Clone errors that mean "this filesystem cannot", not a bug here. */
const REFUSALS = new Set(["EXDEV", "EPERM", "ENOTSUP", "EACCES", "ENOSYS"]);

/**
 * Clone `bin` (symlinks resolved) into `dir` as `name`. A name already holding
 * a current clone of it is left alone — no churn, no fresh scan; otherwise the
 * clone is swapped in with one rename, so a concurrent launch through the same
 * name never finds it missing or half-made, and an upgrade reaches it. A
 * hardlink left by an older build is not a clone, so it is replaced.
 */
export async function cloneNamedBinary(opts: {
  bin: AppPath;
  dir: AppPath;
  name: string;
}): Promise<NamedBinary> {
  const path = joinAppPath(opts.dir, opts.name);
  const source = await realpath(opts.bin);
  const sourceStat = await stat(source);
  await mkdir(opts.dir, { recursive: true });
  await removeOrphanStaging(opts.dir);
  if (await isCurrentClone(path, sourceStat)) return { kind: "cloned", path };
  const staging = joinAppPath(opts.dir, `.${stagingSuffix()}`);
  try {
    // The clone keeps the source's mtime (to the nanosecond), which is how
    // `isCurrentClone` — and the `./equin` script — recognise it later.
    await copyFile(source, staging, constants.COPYFILE_FICLONE_FORCE);
    await rename(staging, path);
  } catch (err) {
    await rm(staging, { force: true });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === undefined || !REFUSALS.has(code)) throw err;
    return { kind: "refused", code };
  }
  return { kind: "cloned", path };
}

/**
 * A staging name `stagingSuffix` made (`.<pid>.<seq>.tmp`, `.verbs.<pid>.<seq>.tmp`)
 * — or the pid-only `.<pid>.tmp` of the builds before it — with its writer's pid.
 */
const STAGING_RE = /^\..*?(\d+)(?:\.\d+)?\.tmp$/;

/**
 * Remove the staging files in `dir` whose writer is gone: one killed between
 * its copy and its rename, and every one the hardlink builds left — there,
 * `rename` between two names of one inode is a no-op, so each rebuild of an
 * already-named backend kept its staging name: 303 names of mise's Bun inode
 * on 2026-11-12 (central's `bin/` alone held 210), the many-names hazard at
 * the top of this file. Run on every call, the current-clone path included,
 * so a directory heals the next time anything is named in it. A live writer's
 * staging (another process cloning here now) is its own business.
 */
async function removeOrphanStaging(dir: AppPath): Promise<void> {
  for (const entry of await readdir(dir)) {
    const pid = STAGING_RE.exec(entry)?.[1];
    if (pid === undefined) continue;
    if (Number(pid) === process.pid || pidAlive(Number(pid))) continue;
    await rm(joinAppPath(dir, entry), { force: true });
  }
}

/** Whether a process with this pid exists (EPERM: it does, as another user). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    throw err;
  }
}

/**
 * Whether `path` is a current clone of one of `bins` (symlinks resolved) —
 * what {@link cloneNamedBinary} would leave alone. False when `path` is gone.
 * For whoever keeps clones past their process (the sdk runtime's agents) and
 * must tell one an upgrade left behind.
 */
export async function isCurrentCloneOf(
  path: AppPath,
  bins: readonly AppPath[],
): Promise<boolean> {
  for (const bin of bins) {
    if (await isCurrentClone(path, await stat(await realpath(bin))))
      return true;
  }
  return false;
}

/**
 * `path` is a current clone of the file `source` describes: a file of its own
 * (one name — a hardlink is the hazard above, not a clone) with its size and
 * mtime.
 */
async function isCurrentClone(path: AppPath, source: Stats): Promise<boolean> {
  let s: Stats;
  try {
    s = await stat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  return (
    s.nlink === 1 && s.size === source.size && s.mtimeMs === source.mtimeMs
  );
}

/**
 * Where a checkout keeps its own Bun as a clone (`bun`) plus a `stamp`, and
 * `verbs` — a symlink to the machine-wide directory of named Buns `./equin`
 * runs the CLI under (`equin · <verb>`) — relative to the checkout root. Under
 * `node_modules/`, so it is ignored and goes with a dependency wipe. Spelled
 * again in the `./equin` script, which reads it before any TypeScript runs.
 */
export const CHECKOUT_BUN_DIR = "node_modules/.cache/equin-bun";

/**
 * Record `bin` (the Bun this CLI runs on) as the checkout's Bun, for `./equin`
 * to name the next CLI process from, and point the checkout's `verbs` at
 * `verbsDir` — the machine-wide clones of that Bun, one per verb. A shell
 * cannot find the real Bun behind mise's shim without spawning mise, nor the
 * data root, so the CLI — which knows both — leaves them there. Trusted by the
 * script only while `stamp` is newer than `mise.lock`, so a toolchain change is
 * followed: that run goes through the shim, unnamed, and lands here again. A
 * clone, not a link of the real Bun: every checkout's name for that inode would
 * be one more name for syspolicyd to be handed after it is gone (see the top of
 * this file) — and plain `bun` runs it.
 *
 * The verb names are machine-wide, not per checkout: each fresh name costs a
 * scan on its first exec, and per-checkout names (`equin · <verb> · <checkout>`)
 * made every new worktree pay a dozen. Those older names are removed here.
 */
export async function refreshCheckoutBun(
  root: AppPath,
  bin: AppPath,
  verbsDir: AppPath,
): Promise<NamedBinary> {
  const trusted = (await checkoutBun(root)) !== null;
  const dir = joinAppPath(root, CHECKOUT_BUN_DIR);
  const named = await cloneNamedBinary({ bin, dir, name: "bun" });
  if (named.kind !== "cloned") return named;
  if (!trusted) await writeFile(joinAppPath(dir, "stamp"), "");
  await mkdir(verbsDir, { recursive: true });
  await pointSymlink(dir, "verbs", verbsDir);
  // An older script's per-checkout names. A `<name>.<pid>` is a script's clone
  // in flight to its name: not touched.
  for (const entry of await readdir(dir))
    if (entry.startsWith(`${PRODUCT_NAME} · `) && !/\.\d+$/.test(entry))
      await rm(joinAppPath(dir, entry), { force: true });
  return named;
}

/** `dir/name` points at `target`, swapped in with one rename when it does not. */
async function pointSymlink(
  dir: AppPath,
  name: string,
  target: AppPath,
): Promise<void> {
  const link = joinAppPath(dir, name);
  try {
    if ((await readlink(link)) === target) return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EINVAL") throw err;
  }
  const staging = joinAppPath(dir, `.${name}.${stagingSuffix()}`);
  await rm(staging, { force: true });
  await symlink(target, staging);
  await rename(staging, link);
}

/**
 * The checkout's Bun while it is still the one `mise.lock` picks (its stamp is
 * newer), or null — none recorded yet, or the toolchain moved since. The same
 * test the `./equin` script makes.
 */
export async function checkoutBun(root: AppPath): Promise<AppPath | null> {
  const dir = joinAppPath(root, CHECKOUT_BUN_DIR);
  const bun = joinAppPath(dir, "bun");
  if ((await statIno(bun)) === null) return null;
  return (await mtimeOf(joinAppPath(dir, "stamp"))) >
    (await mtimeOf(joinAppPath(root, "mise.lock")))
    ? bun
    : null;
}

async function statIno(path: AppPath): Promise<number | null> {
  try {
    return (await stat(path)).ino;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** A missing file is older than everything. */
async function mtimeOf(path: AppPath): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return -Infinity;
    throw err;
  }
}
