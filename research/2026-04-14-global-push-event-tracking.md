# Push event tracking — git trailer as source of truth

## Context

When `./equin push` succeeds, two things should happen:
1. A `pushes` row is recorded for the source conversation.
2. The conversation's `status` flips to `pushed`.

The tricky part: the CLI runs in an agent's worktree shell, outside any server process. The "state divergence" failure mode is if the CLI writes directly to the main-server DB on a schema it can drift from. Multiple agents may also share a single worktree in the future (e.g. a review agent), so a branch name cannot identify the source conversation.

**Chosen approach.** Git carries the identity; the server derives state from git.

- The CLI stamps every commit it creates with a `Singularity-Conversation: <id>` git trailer, read from `$SINGULARITY_CONVERSATION_ID` in the pane's env.
- The main-namespace server watches `main`'s ref. When a new commit lands carrying that trailer, it inserts a `pushes` row and flips that conversation's status to `pushed`.
- Backfill on server startup replays git history so nothing is lost when the server is down.

Why per-commit (not per-push, not squashed): preserves bisect/per-commit review; handles multi-agent branches naturally (each agent's commits attribute to its own conversation); the existing `pushes` table already has one row per sha (`plugins/conversations/server/schema.ts:36-44`), so it fits.

Forward-compat posture: the contract is three strings — trailer name, env var name, ref watched. Unknown trailers are ignored; old commits without a trailer are a no-op, not a corruption.

## Changes

### 1. Schema — `plugins/conversations/server/schema.ts`

- Add `"pushed"` to `ConversationStatusSchema` enum (line 6-12).
- Add `sha` uniqueness constraint on `pushes.sha` (prevents double-recording during backfill + live watch races). Use `unique()` via drizzle.
- Run `./equin build` to regenerate migrations (never run drizzle-kit manually, per CLAUDE.md).

### 2. Tmux runtime — inject env var

`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts:95-110`

Modify `create()` to export the conversation id in the spawned shell so it's inherited by the Claude process and any child shells it launches:

```ts
`zsh -l -c 'export SINGULARITY_CONVERSATION_ID=${conversationId}; ${CLAUDE}'`
```

Escape defensively (conversationId is a generated id, not user input, but still). No migration needed for existing conversations — user confirmed we don't need to handle them.

### 3. CLI — stamp trailer at commit time

`cli/src/commands/push.ts:91-103` (worktree flow) and `cli/src/commands/push.ts:91-103, 112-131` (`--from-main` flow) both go through the same `git commit -m "$msg"` line (line 97).

Change that single commit call to:

```ts
const convId = process.env.SINGULARITY_CONVERSATION_ID;
const args = ["git", "commit", "-m", opts.message];
if (convId) {
  args.push("--trailer", `Singularity-Conversation=${convId}`);
}
await exec(args);
```

Behavior when env var is missing (manual push from a random shell): commit is created without the trailer, the server simply does not record it. Explicit degradation, no guessing.

Note: the CLI is the only path that creates conversation commits (CLAUDE.md forbids raw `git commit`), so stamping here covers all cases without needing a separate `commit` subcommand.

### 4. Server — main-ref watcher + backfill

New file: `plugins/conversations/server/internal/push-watcher.ts`

- **Runs only in the main namespace.** Gated via the same mechanism other "main-only" code uses (check how the existing conversation poller is gated — likely a namespace check on boot).
- **Backfill on start**: `git log main --format='%H%n%B%n--END--'` on the main worktree path, parse `Singularity-Conversation: <id>` trailers, upsert `pushes` rows by sha (`onConflictDoNothing` on the new unique sha index). For each landed commit, update the associated conversation's status to `pushed` (last-write-wins is fine: a later `working` from tmux runtime shouldn't overwrite `pushed`; see §5).
- **Live watch**: 1s poll of `git rev-parse refs/heads/main` on the main worktree. On change, read new commits with `git log <prev>..<new>` and process each the same way. Polling matches the existing conversations poller pattern (`poller.ts`). Avoids fs-watch edge cases on `.git/refs/heads/main` (packed refs).
- **SSE broadcast**: emit a `ConversationEvent` (`protocol.ts:3-10`) when a push is recorded, so the UI updates live. Likely a new event type `pushed`, or reuse the existing `status` event.

### 5. Status precedence — the tmux poller must not overwrite `pushed`

`plugins/conversations/server/poller.ts` (the file at line 9-12 that derives status from runtime state) currently clobbers status every tick. Adjust derivation so `pushed` is terminal from the poller's POV:

```ts
if (current === "pushed") return; // terminal — don't downgrade to working/needs_attention
```

`pushed` only gets set by the push watcher. Re-push on the same conversation re-affirms it (no-op).

### 6. UI — surface the new status

`plugins/conversations/plugins/conversation-view/plugins/status/web/StatusBadge.tsx` (from the plugin map): add a color/label mapping for `pushed`. Minor, but needed so the existing badge doesn't render a blank state.

Out of scope for this plan: a dedicated "pushes list" pane. The `pushes` table is recorded correctly so a later UI can consume it (user mentioned this as a future goal).

## Critical files

- `plugins/conversations/server/schema.ts` — enum + unique index
- `plugins/conversations/server/poller.ts` — `pushed` precedence
- `plugins/conversations/server/internal/push-watcher.ts` — **new**
- `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts:95-110` — env var
- `cli/src/commands/push.ts:91-103` — `--trailer` flag
- `plugins/conversations/plugins/conversation-view/plugins/status/web/StatusBadge.tsx` — badge color
- `plugins/conversations/server/protocol.ts` — SSE event (extend or reuse `status`)

## Verification

1. `./equin build` (applies migration, restarts server with watcher + tmux env injection).
2. Create a new conversation. Inside its tmux pane: `echo $SINGULARITY_CONVERSATION_ID` — should print the conversation id.
3. Make a trivial edit, run `./equin push -m "test trailer"`.
4. `git log main -1 --format=%B` on the main worktree — should show the `Singularity-Conversation:` trailer.
5. In the UI, the conversation's status badge flips to `pushed` within ~1s; a `pushes` row exists in the DB for that conversation with the commit sha.
6. Backfill test: stop server, push another commit from a second conversation, restart server — the second push should appear without a live-watch tick ever having fired.
7. Negative test: run `./equin push -m "no env"` from a shell without `SINGULARITY_CONVERSATION_ID` set — commit lands on main with no trailer, no `pushes` row recorded, no status change. No error.
