import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";

// A local metadata read serving an open HTTP request; only a wedged child
// reaches this, and it then fails as a named error (see machine/internal/get-file-content.ts).
const GIT_TIMEOUT_MS = 30_000;

// Positive answers only: a checkout root stays one, while a folder that is not
// one today can become one (`git init`), so a "no" is re-asked every time.
const roots = new Map<string, string>();

/**
 * The checkout an absolute path names, when it names one EXACTLY: the path is
 * the toplevel of a git checkout (compared after resolving symlinks, so
 * `/tmp/x` and `/private/tmp/x` agree). A folder inside a checkout, a path
 * that does not exist, or a relative path is not a checkout root → `null`.
 *
 * Accepting only the toplevel keeps one spelling per checkout — every read
 * under it is still a relative path the ref/containment checks govern.
 */
export async function resolveCheckoutRoot(
  path: string,
): Promise<string | null> {
  if (!isAbsolute(path) || path.includes("\0")) return null;
  const cached = roots.get(path);
  if (cached !== undefined) return cached;

  let real: string;
  try {
    real = await realpath(path);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  const result = await spawnCaptured(
    [GIT, "--no-optional-locks", "-C", real, "rev-parse", "--show-toplevel"],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  // Non-zero: not inside any work tree (or a bare repo / .git dir).
  if (result.exitCode !== 0) return null;
  const toplevel = await realpath(result.stdout.trim());
  if (toplevel !== real) return null;
  roots.set(path, real);
  return real;
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
