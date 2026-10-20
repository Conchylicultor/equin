import { join } from "node:path";
import { isRelease, REPO_ROOT } from "./paths";

/**
 * The environment that makes a mise shim resolve THIS checkout's toolchain from
 * any working directory: `MISE_GLOBAL_CONFIG_FILE` set to `<REPO_ROOT>/mise.toml`.
 * Empty in a compiled release, which has no checkout and spawns no mise tool.
 *
 * The runtime PATH puts mise's shims first (launcher/core `runtimePath`), and a
 * shim picks its version from the `mise.toml` + `mise.lock` found by walking up
 * from its cwd. With none above it, mise runs the next NON-mise copy of the
 * tool on PATH if there is one — Homebrew's, unlocked — and otherwise
 * fails: `mise ERROR No version is set for shim: bun`. Neither is the version
 * `mise.lock` declares. A cwd is incidental to which toolchain a process belongs
 * to; the checkout it runs from is not.
 *
 * mise uses the global config only when the walk finds no local one, and reads
 * the `mise.lock` beside it, so this changes nothing inside a checkout — a
 * worktree trialling an upgrade still gets its own lock — and outside one gives
 * exactly the locked versions. `~/.config/mise/config.toml` still loads beside
 * it, so its `trusted_config_paths` keep applying, and a global config needs no
 * `mise trust`. The `toolchain:resolved` check re-measures this on every build,
 * since it rests on mise's semantics rather than ours.
 *
 * Each backend and central apply it to their own `process.env` at boot, so
 * everything they spawn inherits it. The starter's own `MISE_*` never reaches
 * them: the declared runtime environment (launcher/core) does not carry it.
 */
export function toolchainPin(): { MISE_GLOBAL_CONFIG_FILE?: string } {
  if (isRelease()) return {};
  return { MISE_GLOBAL_CONFIG_FILE: join(REPO_ROOT, "mise.toml") };
}
