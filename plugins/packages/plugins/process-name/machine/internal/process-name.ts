import {
  constants,
  copyFileSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";

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

/** Bytes kept of a name — APFS names are at most 255 bytes. */
const MAX_NAME_BYTES = 200;

/**
 * `equin · <kind> · <id>`, as a file name: no `/`, no control characters,
 * bounded. Kind first, so a list sorted by name groups every build, every
 * agent, every server together.
 */
export function processName(kind: string, id?: string): string {
  const parts = [PRODUCT_NAME, kind, ...(id ? [id] : [])].map((p) =>
    p
      .replace(/[\u0000-\u001f\u007f/:]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const name = parts.join(" · ");
  const bytes = new TextEncoder().encode(name);
  if (bytes.length <= MAX_NAME_BYTES) return name;
  return new TextDecoder()
    .decode(bytes.slice(0, MAX_NAME_BYTES))
    .replace(/�+$/, "");
}

export type NamedBinary =
  | { kind: "cloned"; path: AppPath }
  /** The filesystem refused the clone (not APFS, another volume, no permission): run `bin` itself. */
  | { kind: "refused"; code: string };

/** Clone errors that mean "this filesystem cannot", not a bug here. */
const REFUSALS = new Set(["EXDEV", "EPERM", "ENOTSUP", "EACCES", "ENOSYS"]);

/**
 * Clone `bin` (symlinks resolved) into `dir` as `name`. A name already holding
 * a current clone of it is left alone — no churn, no fresh scan; otherwise the
 * clone is swapped in with one rename, so a concurrent launch through the same
 * name never finds it missing or half-made, and an upgrade reaches it. A
 * hardlink left by an older build is not a clone, so it is replaced.
 */
export function cloneNamedBinary(opts: {
  bin: AppPath;
  dir: AppPath;
  name: string;
}): NamedBinary {
  const path = joinAppPath(opts.dir, opts.name);
  const source = realpathSync(opts.bin);
  const sourceStat = statSync(source);
  mkdirSync(opts.dir, { recursive: true });
  if (isCurrentClone(path, sourceStat)) return { kind: "cloned", path };
  const staging = joinAppPath(opts.dir, `.${String(process.pid)}.tmp`);
  rmSync(staging, { force: true });
  try {
    // The clone keeps the source's mtime (to the nanosecond), which is how
    // `isCurrentClone` — and the `./equin` script — recognise it later.
    copyFileSync(source, staging, constants.COPYFILE_FICLONE_FORCE);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === undefined || !REFUSALS.has(code)) throw err;
    return { kind: "refused", code };
  }
  renameSync(staging, path);
  return { kind: "cloned", path };
}

/**
 * `path` is a current clone of the file `source` describes: a file of its own
 * (one name — a hardlink is the hazard above, not a clone) with its size and
 * mtime.
 */
function isCurrentClone(path: AppPath, source: Stats): boolean {
  let s: Stats;
  try {
    s = statSync(path);
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
 * the names `./equin` runs it under — relative to the checkout root. Under
 * `node_modules/`, so it is ignored and goes with a dependency wipe. Spelled
 * again in the `./equin` script, which reads it before any TypeScript runs.
 */
export const CHECKOUT_BUN_DIR = "node_modules/.cache/equin-bun";

/**
 * Record `bin` (the Bun this CLI runs on) as the checkout's Bun, for `./equin`
 * to name the next CLI process from. A shell cannot find the real Bun behind
 * mise's shim without spawning mise, so the CLI — which knows it — leaves it
 * there. Trusted by the script only while `stamp` is newer than `mise.lock`, so
 * a toolchain change is followed: that run goes through the shim, unnamed, and
 * lands here again. A clone, not a link of the real Bun: every checkout's name
 * for that inode would be one more name for syspolicyd to be handed after it
 * is gone (see the top of this file) — and plain `bun` runs it.
 */
export function refreshCheckoutBun(root: AppPath, bin: AppPath): NamedBinary {
  const trusted = checkoutBun(root) !== null;
  const dir = joinAppPath(root, CHECKOUT_BUN_DIR);
  const named = cloneNamedBinary({ bin, dir, name: "bun" });
  if (named.kind !== "cloned") return named;
  if (!trusted) writeFileSync(joinAppPath(dir, "stamp"), "");
  // The script's per-verb names, kept current here too: one an older build
  // hardlinked has the clone's mtime and is no longer the same file as `bun`,
  // so the script alone would take it for a current clone and keep running it.
  // A `<name>.<pid>` is a script's clone in flight to its name: not touched.
  for (const entry of readdirSync(dir))
    if (entry.startsWith(`${PRODUCT_NAME} · `) && !/\.\d+$/.test(entry))
      cloneNamedBinary({ bin: named.path, dir, name: entry });
  return named;
}

/**
 * The checkout's Bun while it is still the one `mise.lock` picks (its stamp is
 * newer), or null — none recorded yet, or the toolchain moved since. The same
 * test the `./equin` script makes.
 */
export function checkoutBun(root: AppPath): AppPath | null {
  const dir = joinAppPath(root, CHECKOUT_BUN_DIR);
  const bun = joinAppPath(dir, "bun");
  if (statIno(bun) === null) return null;
  return mtimeOf(joinAppPath(dir, "stamp")) >
    mtimeOf(joinAppPath(root, "mise.lock"))
    ? bun
    : null;
}

function statIno(path: AppPath): number | null {
  try {
    return statSync(path).ino;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** A missing file is older than everything. */
function mtimeOf(path: AppPath): number {
  try {
    return statSync(path).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return -Infinity;
    throw err;
  }
}
