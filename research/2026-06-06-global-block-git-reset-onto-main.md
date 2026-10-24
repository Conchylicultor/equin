# Block `git reset` onto main + fix the nudges that caused a stale-base clobber

## Context

A push from a stale base silently reverted unrelated work off `main`. Mechanics:
an agent's worktree forked from `main` at commit **B**; while it worked, `main`
advanced to **N** (an entire app + a primitive feature + research docs landed in
between). To "collapse its commits" the agent ran `git reset --soft origin/main`.
Because `origin/main` (N) had advanced past the fork point B, the reset moved the
**branch pointer** to N while leaving the index/worktree at **B + work**. The
staged diff `(N → B+work)` therefore encoded *"delete everything that landed in
between."* `./equin push` faithfully committed and merged that, reverting
the intervening work off `main`. Nothing flagged it; caught only by chance.

Two things in the repo actively nudge agents toward this command:
- `push.ts` rebase-failure message recommends `git reset --hard origin/main`.
- The `feedback_always_rebase.md` memory recommends `git reset --hard origin/main` as "option 2".

**Decision (scope):** there is **no legitimate use** for resetting a branch
*onto* `main`/`origin/main` — squashing own commits is `git reset --soft
$(git merge-base HEAD main)` / `HEAD~N`, and integrating a moved main is `git
rebase`. So we **exhaustively block the command** (front-line prevention, like the
existing `git push` guard) and **remove the guidance that recommends it**.

We are intentionally **not** building the durable fork-base record or the
push-time clobber check in this pass. Residual gap accepted: the guard kills the
#1 known cause, but the same silent-deletion *state* could still reach `main` via
a botched manual rebase, a manual `rm`, or the `--from-main` path. If that ever
happens, revisit the push-time check (see the deferred design notes at the end).

## Change 1 — Blanket guard: block `git reset` onto main

New PreToolUse guard, mirroring `git-push.ts` (pure string parse, no git exec).

**New file:** `plugins/framework/plugins/tooling/plugins/guards/core/guards/git-reset-main.ts`

```ts
import { defineGuard } from "../define-guard";
import { findCall } from "../parse-shell";
import type { BashInput } from "../types";

// Spellings of the shared integration ref that must never be a reset *target*.
// Deliberately excludes @{u}/@{upstream}: a worktree branch's upstream is its own
// origin/<branch>, not main, so blocking those would be a false positive.
const MAIN_REFS = new Set([
  "main",
  "origin/main",
  "origin/HEAD",
  "refs/heads/main",
  "refs/remotes/origin/main",
]);

export const gitResetMainGuard = defineGuard<BashInput>({
  name: "git-reset-main",
  matcher: "Bash",
  check(input) {
    const cmd = input.command;
    if (!cmd) return null;
    const reset = findCall(
      cmd,
      (c) => c.name === "git" && c.args[0] === "reset" && resetsBranchOntoMain(c.args),
    );
    if (!reset) return null;
    return {
      blocked: "`git reset` onto main/origin/main is not allowed.",
      why:
        "Resetting your branch onto main when main has moved past your fork point silently " +
        "stages a deletion of every commit that landed in between. A previous agent ran " +
        "`git reset --soft origin/main` and the next push reverted an entire app off main.",
      hint:
        "Main moved and you want its commits: `git stash` (if dirty) then `git rebase origin/main`. " +
        "Only squashing your own commits: `git reset --soft $(git merge-base HEAD main)` then recommit. " +
        "Never reset your branch onto main itself.",
    };
  },
});

// True only when the args move HEAD onto a main ref. A `git reset <ref> -- <paths>`
// form only restores files and never moves the branch, so it is always allowed.
function resetsBranchOntoMain(args: string[]): boolean {
  if (args.includes("--")) return false; // pathspec form — never moves HEAD
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) continue; // skip flags (--soft/--mixed/--hard/-q/…)
    return MAIN_REFS.has(a); // first non-flag token is the target ref
  }
  return false; // bare `git reset` → defaults to HEAD
}
```

**Register:** `plugins/framework/plugins/tooling/plugins/guards/core/registry.ts`
— import `gitResetMainGuard` and add it to the Bash section of `GUARDS` (next to `gitPushGuard`).

**Behavior table**

| Command | Verdict |
|---|---|
| `git reset --soft origin/main` / `--mixed main` / `--hard origin/main` / `git reset main` | **deny** |
| `git stash && git reset --soft origin/main` (compound) | **deny** (`findCall` scans all calls) |
| `git reset --soft $(git merge-base HEAD main)` | allow (ref token is `$(git`, not a literal main spelling) |
| `git reset --soft HEAD~3`, `git reset HEAD`, bare `git reset` | allow |
| `git reset origin/main -- file.ts` (path form) | allow |

Known accepted hole: `git reset --soft $(git rev-parse origin/main)` resolves to
main but reads as a non-main token — slips through, same as the `git push` guard's
string-level philosophy. Acceptable; the guidance discourages it anyway.

## Change 2 — Remove the nudges toward the blocked command

**a) `plugins/framework/plugins/cli/bin/commands/push.ts` lines 452–453.** In the
rebase-failure message, replace the `git reset --hard origin/main` suggestion:

```
- `If main's shape has diverged enough that your commit no longer makes sense,`,
- `'git reset --hard origin/main' + reapply as a fresh commit is cleaner than rebasing.`,
+ `If main's shape has diverged so much your commit no longer applies, re-apply your`,
+ `changes by hand onto a fresh worktree branched from origin/main. Never 'git reset'`,
+ `your branch onto main — it stages a deletion of every commit that landed in between.`,
```

(Lines 486 and 377 mention `git reset --soft HEAD~1` to unstage — that is safe and
allowed by the guard; leave them unchanged.)

**b) `~/.claude/projects/-Users-epot---A---dev-singularity/memory/feedback_always_rebase.md`**
(user-level memory, **not** version-controlled with the repo). Rewrite option 2:

```
- 2. `git reset --hard origin/main` + reapply changes as a fresh single commit (cleanest when main's
-    shape changed enough that your original diff no longer makes sense).
+ 2. If main's shape diverged so much your diff no longer applies, re-apply your changes by hand onto a
+    fresh branch from `origin/main`. NEVER `git reset` your branch onto `origin/main`/`main`: when main
+    has moved past your fork point it silently stages a deletion of every commit that landed in between,
+    and the next `./equin push` reverts that work off main. (This command is now blocked by a guard.)
```

Also update the `MEMORY.md` index line for it: drop the "or reset + reapply"
phrasing and note the warning, e.g.:
`Always rebase (never merge) to integrate main; never reset a branch onto main — it stages a silent deletion of intervening commits`.

## Files touched

- `plugins/framework/plugins/tooling/plugins/guards/core/guards/git-reset-main.ts` (new)
- `plugins/framework/plugins/tooling/plugins/guards/core/registry.ts` (import + register)
- `plugins/framework/plugins/cli/bin/commands/push.ts` (message text, ~L452–453)
- `~/.claude/.../memory/feedback_always_rebase.md` + `MEMORY.md` (user memory, outside repo)

No schema, no migration, no new plugin, no codegen registry edits (guards register statically).

## Verification

1. `./equin build` (compiles the guard; runs checks incl. eslint).
2. Guard unit behavior — feed commands through the guard runner and assert deny/allow.
   The guards plugin entrypoint is `plugins/framework/plugins/tooling/plugins/guards/bin/guard.ts`
   (reads a PreToolUse JSON on stdin, emits the decision). Drive it with each row of the
   behavior table and confirm `permissionDecision: "deny"` only for the main-reset rows:
   ```bash
   echo '{"tool_name":"Bash","tool_input":{"command":"git reset --soft origin/main"}}' \
     | bun plugins/framework/plugins/tooling/plugins/guards/bin/guard.ts   # expect deny
   echo '{"tool_name":"Bash","tool_input":{"command":"git reset --soft $(git merge-base HEAD main)"}}' \
     | bun plugins/framework/plugins/tooling/plugins/guards/bin/guard.ts   # expect allow (no output / allow)
   echo '{"tool_name":"Bash","tool_input":{"command":"git reset --soft HEAD~2"}}' \
     | bun plugins/framework/plugins/tooling/plugins/guards/bin/guard.ts   # expect allow
   echo '{"tool_name":"Bash","tool_input":{"command":"git reset origin/main -- a.ts"}}' \
     | bun plugins/framework/plugins/tooling/plugins/guards/bin/guard.ts   # expect allow
   ```
   (Confirm the exact stdin/stdout contract by reading `bin/guard.ts` + `core/runner.ts` first.)
3. Live check: in this worktree, actually attempt `git reset --soft origin/main` via a Bash tool
   call and confirm Claude Code surfaces the deny with the hint.
4. Read the rewritten `push.ts` message and the memory to confirm no remaining `reset … origin/main` advice.

## Deferred (not in this pass)

The structural catch-all — a **durable fork-base** written at `setupWorktree`
(`plugins/infra/plugins/worktree/server/internal/worktree.ts`) into the per-worktree
gitdir, plus a **push-time clobber check** (`clobbered = (paths where main≠tip) \
(paths the branch changed vs fork-base)`, deletions-scoped to avoid false positives,
hard-fail with an `.allow-clobber` bypass) — was designed and validated but
explicitly descoped here. It is the only thing that would catch the same state when
produced by something other than this reset command. Revisit if a non-reset clobber occurs.
```