// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe.
import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/**
 * Locates the `mise` binary: PATH first, then its installer's default
 * location — an agent shell often has mise's shims on PATH but not mise
 * itself. Returns `null` (never throws) so a best-effort caller — mise
 * genuinely not installed is a legitimate no-op for them — doesn't need to
 * catch an error to find that out.
 */
export function findMiseBin(): string | null {
  const onPath = Bun.which("mise");
  if (onPath !== null) return onPath;
  // mise's own fixed install location under home — not a user-chosen path.
  const installed = asAppPath(join(HOME_DIR, ".local", "bin", "mise"));
  return existsSync(installed) ? installed : null;
}

/** Same resolution, but throws for a caller that requires mise to proceed. */
export function miseBin(): string {
  const bin = findMiseBin();
  if (bin !== null) return bin;
  throw new Error(
    `mise is not installed (not on PATH, not at ${join(HOME_DIR, ".local", "bin", "mise")}). Install it: https://mise.jdx.dev`,
  );
}
