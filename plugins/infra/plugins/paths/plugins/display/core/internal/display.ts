// The HUMAN-FACING spelling of the data dirs — what a message, a
// UI empty state, or an agent prompt writes when it tells somebody where a
// directory is. The twin of the resolved absolute paths in
// `paths/core/internal/paths.ts`: same directory, written the way a person
// types it (`~`), not the way the filesystem answers (`/Users/<you>/…`).
//
// Kept as literals rather than derived from `PROTOTYPES_DIR`, because the
// derivation would go the wrong way: `PROTOTYPES_DIR` is already expanded, and
// re-shortening it back to `~` would be a second, lossier spelling — and it
// would drag `homedir()` into every consumer. These two files sit side by side
// in one plugin family so a change to either is read against the other.
//
// NOTHING here may import `node:*` or the sibling `paths` module. This plugin
// exists precisely so the browser can name the directory: a `~` string is
// runtime-agnostic, `homedir()` is not.

/**
 * Where throwaway UI prototypes live, as prose (`PROTOTYPES_DIR` is the same
 * directory resolved). Used by the prototypes agent-launch prompts, the gallery
 * empty state, and the `prototypes:self-contained` check's messages — every
 * place that TELLS somebody the path instead of opening it.
 *
 * No trailing slash: consumers that want one write `${PROTOTYPES_DIR_DISPLAY}/`,
 * which is also how a `<slug>` or `_template` gets appended.
 */
export const PROTOTYPES_DIR_DISPLAY = "~/.singularity/apps/prototypes";

/**
 * Where the encrypted secrets blob lives, as prose — the prose twin of the
 * `state/secrets` data dir (`secrets.json.enc` plus the `.key` fallback).
 *
 * Used by the Accounts pane, which tells the user where their connected-service
 * tokens are kept. That copy used to name `~/.singularity/auth/` as a hardcoded
 * literal, and it had been wrong since the secrets plugin took ownership:
 * `migrateLegacyAuthTokens` moves the legacy blob into the secrets store, so
 * `auth/` holds nothing but a stale key file. Naming the directory in one place
 * is what keeps the answer true — a literal in a JSX string is a spelling
 * nothing checks.
 *
 * No trailing slash, same convention as above.
 */
export const SECRETS_DIR_DISPLAY = "~/.singularity/state/secrets";

/**
 * Where the user layer of the three-layer config model lives, as prose — the
 * prose twin of `config_v2`'s `configDir` data dir (`state/config`). One
 * `<worktree>/` subtree per namespace beneath it, each holding the propagated
 * `<name>.origin.jsonc` files and the user's own `<name>.jsonc` overrides.
 *
 * Used by the config conflict prompt, which tells an agent where the user's
 * overrides sit and — the load-bearing half — that the subtree is forked per
 * worktree, so edits the agent makes inside its own worktree are not the user's.
 * A browser-side prompt cannot reach `configDir.path` (node-only), which is
 * exactly what this plugin exists for.
 *
 * No trailing slash, same convention as above.
 */
export const USER_CONFIG_DIR_DISPLAY = "~/.singularity/state/config";

/**
 * Where each namespace's per-worktree state lives, as prose — the prose twin of
 * the resolved `worktreeDir`. One `<namespace>/` subtree beneath it, holding
 * that namespace's build logs, run artifacts and deploy receipt.
 *
 * Used by the exec runtime's identity assert, which has to tell somebody
 * running the command by hand WHERE to find the namespace name it is missing.
 * That is the whole job of this file: a message that names a directory should
 * name it from the one place that knows how it is spelled, not from a literal
 * the next rename walks past.
 *
 * No trailing slash, same convention as above.
 */
export const WORKTREES_DIR_DISPLAY = "~/.singularity/worktrees";
