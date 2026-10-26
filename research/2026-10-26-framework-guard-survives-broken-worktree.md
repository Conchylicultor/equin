# The PreToolUse guard survives a mid-edit worktree

## Context

An agent removed `RESERVED_VIEW_PARAM` from `pane/core/route.ts` before removing its re-export
from `pane/core/index.ts`, and from that moment every tool call was refused: the guard hook
(`guards/bin/guard.ts`) runs from `$EQUIN_GUARDS_ROOT`, which for a worktree is the worktree
itself (on purpose — "so an agent can edit and test them", `agent-policy.ts`), the module failed
to link, bun exited non-zero, and the hook command turns any non-zero exit into a block. The agent
could not edit its way out.

### Why the closure reaches pane core

Measured with `importClosure` (`framework/tooling/import-closure`):

```
guards/bin/guard.ts
  → apps/prototypes/data-dirs/index.ts          (prototypesDir, for writableDataDirs)
  → apps/prototypes/plugins/shell/core/index.ts (prototypesApp, the dir is keyed by its app)
  → apps/prototypes/plugins/shell/core/app.ts   (defineApp)
  → primitives/pane/core/index.ts
```

That is one path of many: the PreToolUse entry loads **104** worktree modules (108 with the
plugin-contributed guards — `apps/prototypes/guard`, `infra/mcp/browser/guard`), across `infra/paths`,
`launcher/env-names`, `namespace`, `ui/icons`, `collected-dir`, every built-in guard…
Trimming this one edge would only move the cliff: any of those modules — the guards' own code
first of all, which agents do edit — breaks the hook the same way.

(The stop guard is already fail-open on a crash — its non-zero exit is non-blocking — so it is
not affected.)

## Design: live guard first, main's guard when the live one cannot run

The trust anchor is a tiny **bootstrap** that imports nothing from the repo:

- `guards/bin/guard.ts` (the path the agent policy already names — no settings change) becomes the
  bootstrap: `node:` builtins only. It reads stdin once, then `await import("./hook")` and calls
  `guardHook(raw)`, which returns the hook's stdout text.
- `guards/bin/hook.ts` is today's entry body (data dirs, `readEnv`, `runHook`), exported as
  `guardHook(raw): Promise<string>` instead of reading stdin / writing stdout itself. `runHook`
  returns the output object instead of writing it.
- If the import or the run **throws** (a module that doesn't link, a throwing guard), the
  bootstrap falls back to the **main checkout's** guard: it resolves main from git
  (`git rev-parse --path-format=absolute --git-common-dir` → its parent; only on the failure path),
  and runs `bun <main>/…/bin/guard.ts` as a subprocess, cwd main, the same stdin. The contract
  between the two checkouts is the Claude Code hook protocol itself — the most stable contract
  available — not a module API that could skew between main and the worktree.
- The fallback's verdict is used, with a **loud notice** appended (deny → appended to
  `permissionDecisionReason`; otherwise `additionalContext`): "your checkout's guard failed to
  load/run: <error, first lines>; main's guards judged this call instead — fix it". Protection is
  kept (main's guards still deny), the failure stays visible on every call, and the agent can edit.
- No fallback when the live checkout IS main, or main's guard also fails → exit non-zero with both
  errors on stderr; the hook command blocks, exactly as today. Never fail open.

Main's guard given the same payload decides the same way: every root the guards judge comes from
the payload's `cwd` and `EQUIN_WORKSPACE_ROOT` (`core/context.ts`), not from the code's location;
`REPO_ROOT` is only read for `protectedRoot`'s main-checkout lookup, which is main either way.

### Keeping the anchor honest (rung 3)

A check `guards:bootstrap-imports-builtins-only`: `bin/guard.ts` may import only `node:*` and its
sibling `./hook` (dynamically). A static repo import there would put the whole closure back in
front of the fallback.

## Files

- `guards/bin/guard.ts` — rewritten as the bootstrap.
- `guards/bin/hook.ts` — new; today's body as `guardHook(raw)`.
- `guards/core/runner.ts` — `runHook` returns `HookOutput | null` (stdout object) instead of
  writing; `recordInformed` still runs only on the non-deny path.
- `guards/check/index.ts` — the new check.
- `guards/CLAUDE.md` — a section "The guard survives a broken checkout".

## Verification

- `./equin test plugins/framework/plugins/tooling/plugins/guards`.
- By hand: break a module in the closure (e.g. a bad re-export in `pane/core/index.ts`), pipe a
  payload into `bun guards/bin/guard.ts` → main's verdict + the notice; restore. A payload for a
  write into main → still denied under the fallback.
- `./equin build` (checks incl. the new one).
