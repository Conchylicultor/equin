import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The declaration file a `cli.generated.ts` entry loads, relative to the repo
 * root. One spelling for the CLI's startup and the checks that read the same
 * registry, so they cannot disagree about which file an entry stands for.
 */
export function cliEntrySourcePath(entry: { pluginPath: string }): string {
  return join("plugins", entry.pluginPath, "cli", "index.ts");
}

/**
 * Whether an entry's declaration is still on disk. A missing one is a stale
 * registry line left by a deleted command — not a broken command — so readers
 * skip it rather than fail on it. That distinction is what lets `./equin`
 * start after a command is deleted, which it must: the CLI is the only thing
 * that regenerates the registry.
 */
export function isCliEntryPresent(
  root: string,
  entry: { pluginPath: string },
): boolean {
  return existsSync(join(root, cliEntrySourcePath(entry)));
}
