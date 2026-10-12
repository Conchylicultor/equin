import { mise } from "./mise";

const MINUTE = 60_000;

/**
 * Install every release this checkout's `mise.lock` records that is not
 * installed yet, and return what was installed (`tool@version`, empty when
 * nothing was missing).
 *
 * A lock names releases; nothing else turns that into binaries. The toolchain
 * updater installs before it writes the lock, so on the machine that ran it the
 * two agree — but a lock that arrives any other way (a fresh clone, a pull on a
 * second machine, an upstream merge, a pruned install) names releases that are
 * not there, and every tool resolved through mise's shims then fails. Shims
 * never install (`not_found_auto_install` is off — research/
 * 2026-09-27-global-mise-shim-self-loop.md), so this installs explicitly,
 * through the real mise binary, the same way the updater does.
 *
 * Throws when mise fails: a build on a toolchain it could not install would
 * fail later, further from the cause.
 */
export async function installLockedToolchain(root: string): Promise<string[]> {
  const missing = (await mise(root, ["ls", "--missing"], MINUTE))
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([name, version]) => name && version)
    .map(([name, version]) => `${name}@${version}`);
  if (missing.length === 0) return [];
  await mise(root, ["install", ...missing], 30 * MINUTE);
  return missing;
}
