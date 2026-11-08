/**
 * Every bypass file a guard may honour (`.allow-main`, …), sorted: a file at
 * the checkout root whose presence lets that guard's calls through.
 *
 * Declared as data rather than derived from the guard registry, so a reader
 * (the conversation view's "bypass active" chip, a backend) gets the set
 * without loading every guard and the blocking helpers they run in their hook
 * process. The two halves cannot drift: a guard's `bypassToken` is a
 * `BypassToken` (tsc refuses an undeclared file), and
 * `guards:bypass-tokens-declared` fails on a declared file no guard honours.
 */
export const BYPASS_TOKENS = [
  ".allow-bun-script",
  ".allow-foreground-ops",
  ".allow-git-push",
  ".allow-macos-automation",
  ".allow-main",
  ".allow-postgres",
  ".allow-wide-search",
] as const;

export type BypassToken = (typeof BYPASS_TOKENS)[number];

/** Whether a file name is one of the declared bypass files. */
export function isBypassToken(name: string): name is BypassToken {
  return (BYPASS_TOKENS as readonly string[]).includes(name);
}
