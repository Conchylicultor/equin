# Add `./equin check` to the worktree op-status system

## Context

Today the agent-manager surfaces in-flight long-running worktree operations —
**build** and **push** (incl. push "waiting for lock") — in two places:

- a **sidebar list chip** (a single muted icon: wrench=build, up-arrow=push,
  hourglass=waiting), and
- a **banner** above the conversation prompt input (with a live elapsed timer),

and it keeps the conversation **status** reading as `working` while the op runs
(otherwise a CLI subprocess in tmux "shell" state falls through to `waiting`).

`./equin check` is missing from all of this. When an agent runs checks
standalone, the conversation shows as `waiting` (idle) even though checks are
actively running, and neither the list chip nor the banner reflects it. We want
to generalize the exact same pattern to `check`: a list icon, a banner status,
and `working` conversation status while checks run.

**Scope (confirmed):** standalone `./equin check` only. Checks that run
*inside* build or push stay subsumed under the existing "Build in progress" /
"Push in progress" status — no new marker is written in those nested contexts,
avoiding label flicker and marker-priority churn.

## How the existing pattern works (the seam)

- The build/push CLI write a per-worktree marker at
  `~/.singularity/worktrees/<slug>/ops/{build,push}.json` via the `worktree`
  primitive (`markWorktreeOpStart` / `clearWorktreeOp`).
- `worktreeOpsResource` (live-state, push mode) loads `resolveActiveWorktreeOps()`
  → `{ slug → WorktreeOpInfo }`; a file watcher on the marker tree notifies it.
- The banner + chip read that resource; `isWorktreeOpActive(slug)` (any live
  marker) makes the tmux runtime report `working`.

The op type is a small union (`"build" | "push"`) threaded through ~5 files —
that union is the seam to extend with `"check"`.

## Design decisions

- **Standalone-only marker.** In `check.ts`, the existing `kind` already
  distinguishes a direct check (`"build"` host slot) from a push-nested check
  (`"exempt"`, signalled by `SINGULARITY_HOST_SLOT_HELD`). Write the `check`
  marker **only when `kind === "build"`** (direct invocation). Nested checks
  write nothing — the push marker already covers them. Build's own `runChecks()`
  is a direct in-process call (not the `check` command), so no check marker is
  written during build either.
- **No "waiting" phase for check.** Checks use the build host-slot *pool*
  (semaphore), not the single push lock. Like builds, the marker is always
  written as `phase: "running"`. No `runningAt`, no queue position.
- **Icon:** `MdScience` (Material "science"/experiment flask) — distinct from
  the wrench/up-arrow/hourglass, reads as "running checks".
- **`working` status:** automatic. `isWorktreeOpActive` is op-agnostic and the
  watcher already globs `*.json`, so once the marker exists the conversation
  reads `working` with zero changes to the poller/runtime/watcher.

## Files to change

### 1. Extend the op union — `plugins/infra/plugins/worktree/server/internal/worktree-op.ts`
- L24: `export type WorktreeOp = "build" | "push" | "check";`
- Update the doc comment on L15 to mention `check`.
- L126 `readLiveMarker` coercion — replace the 2-way coercion with an explicit
  validated 3-way so a `check` marker isn't silently coerced to `build`:
  ```ts
  const KNOWN_OPS = ["build", "push", "check"] as const;
  // ...
  op: KNOWN_OPS.includes(parsed.op as WorktreeOp) ? (parsed.op as WorktreeOp) : "build",
  ```
- `derivePushPhases` (L303–318) already passes non-push ops through untouched —
  no change.

### 2. Shared schema — `plugins/conversations/plugins/conversation-view/plugins/op-status/shared/schemas.ts`
- L6: `op: z.enum(["build", "push", "check"]),`

### 3. CLI check command — `plugins/framework/plugins/cli/bin/commands/check.ts`
- Import `markWorktreeOpStart`, `clearWorktreeOp` from
  `@plugins/infra/plugins/worktree/server`, and a way to resolve the worktree
  slug (`basename(git rev-parse --show-toplevel)` — mirror the local
  `getWorktreeRoot()` helper in `build.ts`/`push.ts`).
- Only for a direct invocation (`kind === "build"`): write the marker before
  `runChecks`, clear it after, with a `process.on("exit")` guard so a
  SIGINT/SIGTERM still clears it (the marker also self-heals via pid-liveness
  reaping if hard-killed). Sketch:
  ```ts
  const isDirect = kind === "build";
  const slug = isDirect ? basename(await getWorktreeRoot()) : null;
  if (slug) {
    markWorktreeOpStart(slug, "check");
    process.on("exit", () => clearWorktreeOp(slug, "check"));
  }
  try {
    const ok = await withHostSlot(kind, () => runChecks(/* … */));
    if (!ok) process.exit(1);
  } finally {
    if (slug) clearWorktreeOp(slug, "check");
  }
  ```
  (Note: `getWorktreeRoot` is duplicated in build.ts/push.ts; mirror precedent
  here. A follow-up could hoist it into the CLI's shared helpers — out of scope.)

### 4. Resource loader priority — `plugins/conversations/plugins/conversation-view/plugins/op-status/server/internal/resource.ts`
- L19–24 currently "push wins over build". Standalone check never co-occurs with
  build/push for the same slug, but make precedence explicit and safe:
  `push > check > build`. Replace the inline condition with a small rank
  comparison so the highest-precedence op wins per slug.

### 5. Banner display — `.../op-status/web/components/op-status-banner.tsx`
- `summaryLabel` (L75): add `if (op.op === "check") return "Check in progress";`
- `buildRows` (L94): treat `check` like `build` (no queue position) — list
  alongside builds (filter `o.op === "build" || o.op === "check"` for the
  no-queue group, keeping pushes as the queued group).
- `OpRowView.phaseText` (L119): `check → "Checking"`, build → "Building".

### 6. Chip display — `.../op-status/web/components/op-status-chip.tsx`
- `displayFor` (L14): add `if (op.op === "check") return { icon: MdScience, title: "Checks running" };`
- Import `MdScience` from `react-icons/md`.

### 7. Docs
- Update `plugins/.../op-status/CLAUDE.md` prose + the autogen reference will be
  refreshed by `./equin build` (codegen). Mention `check` in the marker
  list and icon legend.

### No change needed
- Watcher (`watcher.ts`) — globs `*.json`, picks up `check.json`.
- Poller / tmux runtime — `isWorktreeOpActive` is op-agnostic → `working`
  status is automatic.
- `useWorktreeOp` web hook — reads the resource, no op-type branching.

## Verification

1. `./equin build` (regenerates docs, rebuilds, restarts).
2. `./equin check --list` then trigger a real run: in a worktree, run a
   slow-ish `./equin check` and, while it runs, observe via MCP:
   - `query_db` the `conversations` row → `status = 'working'` for that worktree.
3. UI (`http://<worktree>.localhost:9000`):
   - Sidebar row for the conversation shows the `MdScience` icon with the
     "Checks running" tooltip.
   - The conversation banner above the prompt reads "Check in progress" with a
     live elapsed timer; expanding lists it in the no-queue group.
4. Confirm **standalone-only scope**: run `./equin push` (which runs checks
   in a subprocess) and confirm the status stays "Push in progress" — no
   "Checking" flicker, and no stray `check.json` marker is left behind
   (`ls ~/.singularity/worktrees/<slug>/ops/` shows only `push.json` during push).
5. Kill a running `./equin check` with Ctrl-C and confirm the marker is
   cleared (no stale "Check in progress" lingering) — exercises the exit guard /
   pid-reaping.
