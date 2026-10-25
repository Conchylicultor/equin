import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

// The CLI's own name — what an agent types (`./equin build`) and what the CLI
// calls itself in its usage and error lines.
//
// The legacy name (`LEGACY_IDS.cliShim`) is kept as a shim at the repo root while
// the app moves off it, so every older doc, hint and muscle memory still
// works. Anything that RECOGNISES a CLI invocation (the guards' shell parser)
// must accept both, which is why the set lives here rather than as a literal at
// each match site.

/** The name the CLI answers to and calls itself: `./equin <verb>`. */
export const CLI_NAME = "equin";

/** Every repo-root executable that runs this CLI, the canonical one first. */
export const CLI_NAMES: readonly string[] = [CLI_NAME, LEGACY_IDS.cliShim];

/** Whether `name` (a command's basename) is this CLI under any of its names. */
export function isCliName(name: string): boolean {
  return CLI_NAMES.includes(name);
}

/**
 * A regex fragment matching any of {@link CLI_NAMES} — for a matcher over raw
 * command TEXT (a `ps` line, a transcript's Bash command) that cannot go
 * through the shell parser. Old transcripts and processes say the legacy name,
 * so such a matcher must accept every name, not just {@link CLI_NAME}.
 */
export const CLI_NAME_PATTERN = `(?:${CLI_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
