# run

`./equin run <script.ts> [args…]` — run a repo script with this
worktree's own dependencies guaranteed.

> **Never `bun <file>`. Always `./equin run <file>`.**

## Why the verb exists

Module resolution walks *up* the directory tree, and worktrees live under the
main checkout. So `bun plugins/…/e2e/foo.ts` from a worktree that has no
`node_modules` of its own does not fail — it quietly resolves every dependency
out of `<main checkout>/node_modules`. If that tree is absent or being rewritten
at that instant (main auto-builds on every push, so the window recurs), bun's
auto-install takes over instead, and auto-install ignores the caret range, the
exact version and `bun.lock` alike: it resolves the bare specifier to registry
`latest`.

The consequence, stated without the Playwright specifics that surfaced it: *a
repo script resolves its dependencies from whichever checkout's installed tree
it happens to find first.* A branch that bumps a dependency does not get its
bump. Playwright is simply the one whose mismatch is visible, because it carries
an out-of-band chromium binary and dies with `Executable doesn't exist at …`; a
`drizzle-orm` two minors off would just behave subtly differently.

`bin/index.ts` already runs `ensureDeps()` before dispatch, for every verb, from
a static import closure that reaches no npm package. So this command inherits
the one thing a bare `bun` invocation cannot have: **this worktree's own
`node_modules`, installed from this branch's lock**, plus the postinstall
provisioning that goes with it. Roughly 140 ms when the deps stamp is already
fresh.

It is deliberately **one general verb, not `./equin e2e`.** The defect is
not e2e-specific — the `scripts/` directories under `plugins/` hold a dozen more
runnable scripts, one of which writes to the database through `drizzle-orm` —
and an e2e script is just a script, whose target URL and reporting the harness
already owns.

## The exception, which must be written down

Not every script may route through here.

- **Agent-invoked scripts → `./equin run`.** Dependencies guaranteed.
- **Machine-invoked scripts → stay npm-free, run bare.**

A handful of scripts are launched by the *system*, at moments when there is no
CLI to route through:

| script | launched by | why it cannot use `run` |
|---|---|---|
| `tooling/plugins/provision/scripts/run-provisions.ts` | `bun install` itself | routing it through `run` would recurse into `ensureDeps` |
| `database/plugins/embedded/scripts/start.ts` | the gateway | no CLI in the loop |
| `tooling/plugins/guards/bin/guard.ts` | Claude Code's PreToolUse hook | fires long before anything is built |

They work bare because they are **npm-free by construction** — verified in an
uninstalled worktree, where `guard.ts` and `flock-wait.ts` both resolve their
full import graph with no `node_modules` present. That property is what makes
them exempt, and it is the thing to preserve if you edit one: the day such a
script grows an npm import, it stops being runnable at the moment it is
launched.

## Shape

The reference shape from `plugins/format/`: `cli/index.ts` is the data-only
declaration, `cli/run.ts` the implementation it reaches through a lazy
`import()`. The declaration loads on every `./equin` invocation
(`cli:command-declarations-light` measures its closure); `run.ts` loads only
when this command runs.

**Passthrough.** Everything after `<script>` belongs to the script — `--headed`
and `--url http://…`, and `--help` too. Commander's default is to claim any
flag it recognizes and reject any it does not, so the declaration sets
`passthroughArgs: true`; the mapper turns that into commander's
`passThroughOptions()`, which stops option parsing at the first operand. No
`--` separator is needed. `./equin run --headed foo.ts` still fails
loudly — the flag precedes the script, so no script was named.

**It refuses rather than running something else.** A path that does not exist,
is not a regular file, is not a module, or resolves outside this checkout is an
error naming both the path you typed and the path it resolved to. Bun would
happily execute a directory's `index.ts` or a file in a sibling checkout — and
the sibling checkout is precisely the failure this command closes, so it must
not be reachable through the command that closes it.

**The accepted extensions are the guard's — the same declaration, not a copy of
it.** `MODULE_EXTENSION` lives in `guards/core/module-extension.ts` and is
imported from there by both halves of the rule: the `bun-script` guard denies
`bun <file>` for exactly these extensions and sends the caller here, and this
command accepts exactly these extensions. An extension this command refused but
the guard denied would leave that caller with nowhere to go, and a dead-end hint
is worse than no guard — so the two sets are one set, and there is nothing left
to keep in sync. `.ts`, `.tsx`, `.js`, `.jsx` and their `.mts`/`.cts`/`.mjs`/`.cjs`
forms.

It reaches past `.ts` for a live reason:
`sidequests/ui-mastery/scripts/screenshot-conversation-with-file.mjs` does
`import { chromium } from "playwright"` — this exact defect, in this exact
dependency, in a `.mjs`.

The import is in `cli/run.ts`, the deferred implementation, never in
`cli/index.ts` — a declaration's static closure is measured by
`cli:command-declarations-light`.

**It forwards, it does not judge.** The child's exit code becomes this process's
exit code; the child inherits stdin/stdout/stderr, so it is indistinguishable
from the script run by hand. A child killed by a signal is reported as a
failure even when its exit code is 0 — it did not finish, it was killed.

## An e2e script is an op; every other script is not

A script under a plugin's `e2e/` directory — the convention the e2e harness
owns, read through its `core` barrel's `isE2eScriptPath` — drives the deployed
app with a browser, so running it is an **op** like a direct `./equin
check`: it takes a host CPU grant (one unit — one script, one Chromium, no
fan-out; its queue time is a `host-grant` wait), plants the worktree op marker
(the conversation reads `working`, the banner reads "E2E in progress"), and
lands an op-log record for the Ops Gantt. The lifecycle is
`withDirectOp("e2e", …)` from `op-runtime`, shared with `check` and `test`; the
grant reaches the script through its environment. The script's own exit code is
still the one this process exits with.

Every other script takes the plain path above, byte-for-byte as before: no
grant, no marker, no record. A one-off data script is not an op and must not
queue behind builds to run.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: `./equin run <script.ts> [args…]` — run a repo script against THIS worktree's own dependencies; the correct spelling of `bun <file>`, which silently resolves another checkout's installed tree.
- Cli:
  - Uses: `framework/cli/op-runtime.withDirectOp`

<!-- AUTOGENERATED:END -->
