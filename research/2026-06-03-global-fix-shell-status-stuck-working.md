# Fix: conversations stuck because of the CLI `shell` status

## Context

Conversations that launch a long-running background shell (e.g. an agent that ran
`./equin build` as a background task) get **stuck and never settle**. The
conversation at `http://equin.localhost:9000/c/conv-1780485630-h2vc/terminal`
was reproduced live in this exact state.

### Root cause (confirmed from live state)

Status is computed in `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`
by `resolvePaneStatus()`. It reads the Claude CLI session file
(`~/.claude/sessions/<pid>.json`) and the tmux pane title. Commits `995c5d2e9` /
`829e20480` added:

```ts
if (session.status === "shell") {
  working = true; // override the title's ✳ ready mark
}
```

That override exists for a real reason: while `./equin build` runs, the CLI
keeps the `✳` ready glyph in the pane title **and** writes `status:"shell"`, so
without the override a running build read as `waiting` and wrongly landed in the
needs-input queue.

But the CLI's `"shell"` status is **ambiguous** — it is identical whether Claude is:

1. genuinely waiting on a build/push that *will* finish and resume the agent, or
2. sitting idle at the `❯` prompt with a **never-ending** background shell
   (`bun dev`, `tail -f`, a build whose completion marker never matched).

The override treats both as `working`, so case 2 is pinned to `working` forever.
Live evidence for the stuck conversation: pane title `✳ …` (ready), an empty `❯`
input box with `· 1 shell ·` in the footer, session file `status:"shell"`, and the
background process was Claude's own `until grep -qE "Build complete|…" …; do sleep 3; done`
poller — the build's marker never appeared, so it loops forever and the conversation
stays `working` permanently.

### Goal

Treat the `shell` status as `working` **only when equin itself knows a build or
push is in flight** for that worktree. Any other never-ending background shell falls
through to the normal title reading (`✳ ready → waiting`), so a stalled agent
correctly surfaces for the user instead of looking busy forever.

## Approach

Introduce one uniform, **per-worktree, crash-safe (PID-liveness) "operation in flight"
marker** that both `build` and `push` write, and that `runtime-tmux` reads.

Why a new marker instead of reusing existing signals:
- Agent `./equin build` runs in-process and does **not** populate the
  `build_runs` table (that path is main-only/server-triggered). Its only record is
  `~/.singularity/build-log.jsonl`, whose entries carry **no pid** — not
  liveness-checkable.
- `push` has no in-flight record at all; the global `~/.singularity/push.lock` flock
  only says "a push is happening *somewhere*", not *which* worktree.
- The existing per-worktree `.build.lock` symlink is PID-based but buried in
  web-core internals and build-only. A single uniform marker for both ops keeps the
  reader from having to know about heterogeneous mechanisms.

The marker is keyed on the worktree directory basename, which all three sites agree
on: `build.ts`/`push.ts` use `basename(await getWorktreeRoot())`, and `runtime-tmux`
uses `basename(worktreePath)` (the pane's `pane_start_path`).

### 1. New primitive — `plugins/infra/plugins/worktree`

The `worktree` infra plugin already owns worktree lifecycle helpers and exposes a
server barrel. Add `plugins/infra/plugins/worktree/server/internal/worktree-op.ts`:

```ts
import { mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SINGULARITY_DIR } from "@plugins/infra/plugins/paths/server";

export type WorktreeOp = "build" | "push";

function opsDir(slug: string): string {
  return join(SINGULARITY_DIR, "worktrees", slug, "ops");
}
function opFile(slug: string, op: WorktreeOp): string {
  return join(opsDir(slug), `${op}.json`);
}

// Same semantics as build plugin's isPidAlive: EPERM means alive-but-not-ours.
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

export function markWorktreeOpStart(slug: string, op: WorktreeOp): void {
  mkdirSync(opsDir(slug), { recursive: true });
  writeFileSync(opFile(slug, op),
    JSON.stringify({ op, pid: process.pid, startedAt: new Date().toISOString() }));
}

export function clearWorktreeOp(slug: string, op: WorktreeOp): void {
  rmSync(opFile(slug, op), { force: true });
}

// True if any op file for this worktree names a live pid. Reaps dead/garbage
// files as it goes, so a SIGKILLed build/push self-heals.
export function isWorktreeOpActive(slug: string): boolean {
  let files: string[];
  try { files = readdirSync(opsDir(slug)); } catch { return false; }
  let active = false;
  for (const f of files) {
    const path = join(opsDir(slug), f);
    try {
      const { pid } = JSON.parse(readFileSync(path, "utf8")) as { pid: number };
      if (typeof pid === "number" && isPidAlive(pid)) active = true;
      else rmSync(path, { force: true });
    } catch { rmSync(path, { force: true }); }
  }
  return active;
}
```

Export all three from `plugins/infra/plugins/worktree/server/index.ts`.

> Note on bare `catch`: ESLint's `no-bare-catch` targets floating promises, not
> synchronous `try/catch`. These are sync fs calls; confirm the rule doesn't flag
> them and add the empty-block reasoning inline. If it does flag, narrow to
> `catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }`.

### 2. Build writes the marker — `plugins/framework/plugins/cli/bin/commands/build.ts`

`name = basename(root)` already exists (line 546). Import `markWorktreeOpStart` /
`clearWorktreeOp` from `@plugins/infra/plugins/worktree/server`.

- **Start:** right after the `appendBuildLog({ phase: "started", … })` call (line 556):
  `markWorktreeOpStart(name, "build");`
- **End:** inside `finalizeBuildLog` (lines 568–580), add `clearWorktreeOp(name, "build");`.
  `finalizeBuildLog` is already invoked on every graceful exit (success at 874/912,
  failure at 779) and via `process.on("exit", …)` at line 581 — so the clear is
  covered on all graceful paths; SIGKILL is handled by the reader's PID-liveness reaping.

### 3. Push writes the marker — `plugins/framework/plugins/cli/bin/commands/push.ts`

`withPushLock` (lines 204–225) takes an `onLockAcquired` callback. Compute the slug
once in `action()` (`const slug = basename(await getWorktreeRoot())` — `getWorktreeRoot`
is already used at line 249) and, in the `onLockAcquired` callback passed to
`withPushLock`:

```ts
markWorktreeOpStart(slug, "push");
process.on("exit", () => clearWorktreeOp(slug, "push"));
```

Marking at lock-acquired (not at process start) means we only flag once the push is
actually proceeding. `process.on("exit")` fires on normal completion, every
`process.exit(1)` path (failed_rebase, failed_checks, CLAUDE.md conflict), and after
a thrown error drains — mirroring build's pattern. SIGKILL is reaped by the reader.

### 4. Runtime reads the marker — `tmux-runtime.ts`

Import `isWorktreeOpActive` from `@plugins/infra/plugins/worktree/server` and `basename`
from `node:path`.

Thread an `opActive` boolean into `resolvePaneStatus`. Compute it only for shell panes
(keeps fs reads bounded), inside the existing per-id async resolution in `list()`:

```ts
const slug = basename(panes.get(id)!.worktreePath);
const opActive = state.status === "shell" ? isWorktreeOpActive(slug) : false;
const resolved = resolvePaneStatus(rawTitle, state, opActive);
```

Rewrite the `working` decision in `resolvePaneStatus(rawTitle, session, opActive)`:

```ts
let working: boolean;
if (SPINNER_RE.test(trimmed)) {
  working = true;                       // actively computing
} else if (session.status === "shell") {
  // A background subprocess is attached. Treat as working ONLY when equin
  // knows a build/push is in flight for this worktree — that operation will
  // complete and resume the agent. Any other never-ending background shell
  // (dev server, tail -f, a build whose completion marker never matched) falls
  // through to the title's ✳ ready mark below and reads as waiting, so a stalled
  // agent surfaces for the user instead of looking busy forever.
  working = opActive;
} else if (READY_RE.test(trimmed)) {
  working = false;                      // ✳ ready → idle
} else {
  working = session.status == null || session.status === "busy";
}
```

This preserves the original intent (a real build/push reads as `working`) while
unsticking the never-ending-shell case — including the exact stuck conversation
observed, where the build had finished/stalled but the agent's poller kept the
session in `shell`.

## Critical files

- `plugins/infra/plugins/worktree/server/internal/worktree-op.ts` — **new** primitive
- `plugins/infra/plugins/worktree/server/index.ts` — export the 3 functions
- `plugins/framework/plugins/cli/bin/commands/build.ts` — mark/clear at lines ~556 / ~568
- `plugins/framework/plugins/cli/bin/commands/push.ts` — mark/clear around `withPushLock` (204–225) / `action()` (~249)
- `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts` — `resolvePaneStatus` (100–137) + `list()` (419–478)
- `plugins/conversations/plugins/runtime-tmux/CLAUDE.md` — add `worktree.isWorktreeOpActive` to "Uses"

## Reuse / precedent

- PID-liveness check mirrors `isPidAlive` in `plugins/build/server/internal/run-build.ts`
  (and the `build_runs` orphan reconciler in `plugins/build/server/index.ts`).
- `SINGULARITY_DIR` from `@plugins/infra/plugins/paths/server`; the
  `~/.singularity/worktrees/<slug>/` layout mirrors CLI `worktreeDataDir(name)`
  (`plugins/framework/plugins/cli/bin/paths.ts`).
- `process.on("exit")` finalizer pattern copied from build's `finalizeBuildLog`.
- Boundary: `runtime-tmux/server` and CLI `bin` importing `@plugins/infra/plugins/worktree/server`
  is a legal `plugin.** -> plugin.**`, server→server import (the CLI already imports
  `@plugins/infra/plugins/paths/server`).

## Verification

1. `./equin build` then `./equin check` (boundaries + lint + docs-in-sync).
2. **Build keeps `working`:** in an agent pane run `./equin build` as a
   background task; while it runs, confirm `~/.singularity/worktrees/<slug>/ops/build.json`
   exists with a live pid, and `query_db` shows the conversation `status = 'working'`.
   When the build finishes, the file is gone and status leaves `working`.
3. **Never-ending shell no longer sticks:** in an agent pane run a background
   `tail -f /dev/null` (or `sleep 100000 &`), return to the idle prompt. Session goes
   `shell` but no op marker exists → conversation reads `waiting`, not `working`.
4. **Stuck-poller case:** reproduce the original — start a build-output poller after
   the build is gone; confirm the conversation now settles to `waiting` instead of
   pinning `working`.
5. **Push:** run `./equin push`; confirm `ops/push.json` appears at lock
   acquisition and is removed on completion (success and a forced-failure path), and
   the conversation stays `working` for the push duration.
6. **Crash-safety:** write a marker with a fake dead pid; confirm `isWorktreeOpActive`
   returns false and reaps the file.
```
