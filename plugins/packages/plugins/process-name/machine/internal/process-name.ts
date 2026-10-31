import {
  linkSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";

// macOS names a process by the FILE it executed (`p_comm`, what Activity
// Monitor and `ps -c` show), so every Bun process reads `bun`. `process.title`
// changes nothing there (measured, bun 1.4.4). A hardlink is the same file
// under another name: run through it, the process is listed by that name, at
// no disk cost. Bun reads its own file name only for `bun`, `bunx` and `node`,
// so a name starting with the product name runs plain Bun.

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
  | { kind: "linked"; path: string }
  /** The filesystem refused the link (another volume, no permission): run `bin` itself. */
  | { kind: "refused"; code: string };

/** Link errors that mean "this filesystem cannot", not a bug here. */
const REFUSALS = new Set(["EXDEV", "EPERM", "ENOTSUP", "EACCES"]);

/**
 * Hardlink `bin` (symlinks resolved) into `dir` as `name`, replacing whatever
 * was there in one rename — a concurrent launch through the same name never
 * finds it missing or half-made, and a relink after an upgrade reaches it.
 */
export function linkNamedBinary(opts: {
  bin: string;
  dir: string;
  name: string;
}): NamedBinary {
  const path = join(opts.dir, opts.name);
  const staging = join(opts.dir, `.${String(process.pid)}.tmp`);
  mkdirSync(opts.dir, { recursive: true });
  rmSync(staging, { force: true });
  try {
    linkSync(realpathSync(opts.bin), staging);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === undefined || !REFUSALS.has(code)) throw err;
    return { kind: "refused", code };
  }
  renameSync(staging, path);
  return { kind: "linked", path };
}

/**
 * Where a checkout keeps its own Bun as a hardlink (`bun`) plus a `stamp`, and
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
 * lands here again.
 */
export function refreshCheckoutBun(root: string, bin: string): NamedBinary {
  const dir = join(root, CHECKOUT_BUN_DIR);
  const current = checkoutBun(root);
  if (current !== null && statIno(current) === statIno(bin))
    return { kind: "linked", path: current };
  const linked = linkNamedBinary({ bin, dir, name: "bun" });
  if (linked.kind === "linked") writeFileSync(join(dir, "stamp"), "");
  return linked;
}

/**
 * The checkout's Bun while it is still the one `mise.lock` picks (its stamp is
 * newer), or null — none recorded yet, or the toolchain moved since. The same
 * test the `./equin` script makes.
 */
export function checkoutBun(root: string): string | null {
  const dir = join(root, CHECKOUT_BUN_DIR);
  const bun = join(dir, "bun");
  if (statIno(bun) === null) return null;
  return mtimeOf(join(dir, "stamp")) > mtimeOf(join(root, "mise.lock"))
    ? bun
    : null;
}

function statIno(path: string): number | null {
  try {
    return statSync(path).ino;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** A missing file is older than everything. */
function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return -Infinity;
    throw err;
  }
}
