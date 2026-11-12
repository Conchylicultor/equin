import { HOME_DIR } from "@plugins/infra/plugins/paths/plugins/data-root-layout/core";

/**
 * The home-relative spellings the shell expands before a command sees them:
 * `~`, `~/x`, `$HOME`, `${HOME}/x`. Resolving `~/x` against the cwd instead
 * made it `<cwd>/~/x` — a path inside the checkout, for a call that reaches the
 * whole home directory. `~user` is left alone: another user's home is unknown.
 */
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

export function expandHome(raw: string): string {
  return raw.replace(HOME_PREFIX, () => HOME_DIR);
}
