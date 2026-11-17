import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";

/**
 * One trailer the build stamps into a web dist (`.build-commit`,
 * `.build-graph`, `.central-build`), read from the dist the CALLER names.
 *
 * Only "the file is not there" reads as `null` (before the first build, or a
 * dist composed before that trailer existed). Every other failure throws:
 * these reads once swallowed everything, and a CLI's `webDistDir()` — which
 * throws in a process with no runtime namespace — was read as "the served
 * dist carries no .build-commit", so `./equin version cut` refused every
 * release while main served exactly the commit it wanted.
 */
export async function readDistTrailer(
  distDir: AppPath,
  name: ".build-commit" | ".build-graph" | ".central-build",
): Promise<string | null> {
  try {
    return (await readFile(`${distDir}/${name}`, "utf8")).trim() || null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}
