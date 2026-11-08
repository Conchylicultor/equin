// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe.
import { constants } from "node:fs";
import { access, existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { delimiter, join } from "node:path";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * Locates the `mise` binary: PATH first, then its installer's default
 * location — an agent shell often has mise's shims on PATH but not mise
 * itself. Returns `null` (never throws) so a best-effort caller — mise
 * genuinely not installed is a legitimate no-op for them — doesn't need to
 * catch an error to find that out.
 */
export function findMiseBinSync(): string | null {
  const onPath = Bun.which("mise");
  if (onPath !== null) return onPath;
  // mise's own fixed install location under home — not a user-chosen path.
  const installed = asAppPath(join(HOME_DIR, ".local", "bin", "mise"));
  return existsSync(installed) ? installed : null;
}

/**
 * `findMiseBinSync`'s async twin, for a backend: the same lookup (an
 * executable `mise` in a PATH directory, in order, then the installer's
 * location), every probe off the thread.
 */
export async function findMiseBin(): Promise<string | null> {
  const installed = asAppPath(join(HOME_DIR, ".local", "bin", "mise"));
  const candidates = [
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter((dir) => dir !== "")
      .map((dir) => join(dir, "mise")),
    installed,
  ];
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Whether `path` is there and executable; any other refusal is loud. */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES")
      return false;
    throw err;
  }
}

/** Same resolution, but throws for a caller that requires mise to proceed. */
export function miseBinSync(): string {
  const bin = findMiseBinSync();
  if (bin !== null) return bin;
  throw new Error(
    `mise is not installed (not on PATH, not at ${join(HOME_DIR, ".local", "bin", "mise")}). Install it: https://mise.jdx.dev`,
  );
}
