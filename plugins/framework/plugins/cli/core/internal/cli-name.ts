// The CLI's own name — what an agent types (`./equin build`) and what the CLI
// calls itself in its usage and error lines.
//
// `./singularity` is the legacy spelling, kept as a shim at the repo root while
// the app moves off that name, so every older doc, hint and muscle memory still
// works. Anything that RECOGNISES a CLI invocation (the guards' shell parser)
// must accept both, which is why the set lives here rather than as a literal at
// each match site.

/** The name the CLI answers to and calls itself: `./equin <verb>`. */
export const CLI_NAME = "equin";

/** Every repo-root executable that runs this CLI, the canonical one first. */
export const CLI_NAMES: readonly string[] = [CLI_NAME, "singularity"];

/** Whether `name` (a command's basename) is this CLI under any of its names. */
export function isCliName(name: string): boolean {
  return CLI_NAMES.includes(name);
}
