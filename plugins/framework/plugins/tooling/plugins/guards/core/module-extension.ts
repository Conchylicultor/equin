/**
 * Extensions bun LOADS AS A MODULE — `.ts`, `.tsx`, `.js`, `.jsx` and their
 * `.mts` / `.cts` / `.mjs` / `.cjs` forms.
 *
 * ONE DECLARATION, TWO HALVES OF ONE RULE. The `bun-script` guard denies
 * `bun <file>` for exactly these extensions and sends the caller to
 * `./equin run <file>`, which accepts exactly these extensions. Those two
 * sets must be the same set: an extension `run` refused but the guard denied
 * would leave that caller with nowhere to go, and a dead-end hint is worse than
 * no guard at all. They were briefly two copies of one regex with a comment on
 * each saying "keep these in sync"; a single exported constant is what makes the
 * drift unspellable instead of merely documented.
 *
 * NOT JUST TYPESCRIPT, and that is not hypothetical:
 * `sidequests/ui-mastery/scripts/screenshot-conversation-with-file.mjs` does
 * `import { chromium } from "playwright"` and documents its own usage as
 * `bun <path>.mjs` — the exact resolution defect, in the exact dependency, that
 * this rule exists to stop. A set that stopped at `.ts` would leave it live. The
 * defect is identical for every extension here (module resolution walks up the
 * directory tree regardless of what the file is written in), so there is no
 * reason to treat any of them differently.
 *
 * Lives in `guards/core/` rather than beside the CLI command because this path
 * must stay loadable with NO `node_modules`: the guard fires from a PreToolUse
 * hook, before anything is installed. Node builtins and repo-local imports only
 * — and this file has neither.
 */
export const MODULE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
