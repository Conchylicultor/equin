# Push event tracking — git trailer as source of truth (v2)

Supersedes `2026-04-14-global-push-event-tracking.md`. Changes from v1:

- Any git commit with the env var gets stamped automatically via a `prepare-commit-msg` hook, not just commits made by `./equin push`.
- Commits made in one push are grouped by a `Singularity-Push: <ulid>` trailer, stamped during the rebase step. UI can render them as a single block.
- The main-ref watcher runs in **every** namespace, not only main. Every server derives push state from git into its own DB.

## Context

When `./equin push` succeeds:

1. Every commit landing on `main` as part of that push gets a `pushes` row attributed to its source conversation.
2. All commits from the same push share a `pushId` so the UI can surface them as one block.
3. The source conversation's `status` flips to `pushed`.

Constraints that shaped the design:

- CLI runs in a worktree shell, outside any server process. Direct DB writes from the CLI would risk schema drift ("state divergence") across versions.
- A worktree may host multiple conversations in the future (e.g. a review agent). Branch name cannot identify the source conversation.
- Agents might commit outside `./equin push` (CLAUDE.md forbids this, but the system should be robust, not rely on convention).

**Approach: git carries identity, every server derives state from git.**

- Every commit made inside a Claude pane is auto-stamped with `Singularity-Conversation: <id>` via a repo-level `prepare-commit-msg` hook that reads `$SINGULARITY_CONVERSATION_ID`.
- `./equin push` generates a `Singularity-Push: <ulid>` during its rebase step and stamps every commit in the push with it via `git rebase --exec`.
- Every server (every namespace) runs a main-ref watcher that tails `refs/heads/main`, reads trailers on new commits, and upserts `pushes` rows + `status=pushed` into its own DB. Backfill on startup.

Forward-compat: contract is two trailer names, one env var, one ref. Unknown trailers are ignored. Commits without trailers are no-ops. Servers never write to each other; they independently derive from the shared git object store (git worktrees share `.git`).

## Changes

### 1. Git hook — `.githooks/prepare-commit-msg` (new, committed)

```bash
#!/bin/sh
# Auto-stamp Singularity-Conversation trailer on every commit when the pane's
# conversation id is in the env. No-op if missing (e.g. manual commit from main shell).
if [ -n "$SINGULARITY_CONVERSATION_ID" ]; then
  if ! grep -q "^Singularity-Conversation:" "$1" 2>/dev/null; then
    git interpret-trailers --in-place \
      --trailer "Singularity-Conversation=$SINGULARITY_CONVERSATION_ID" "$1"
  fi
fi
```

- `chmod +x .githooks/prepare-commit-msg` (committed executable).
- Idempotent under amend/rebase: checks for existing trailer before appending.
- **One-time setup** (not auto-run): add a step to `docs/setup.md` instructing contributors to run `git config core.hooksPath .githooks` after cloning. `core.hooksPath` is per-clone (stored in `.git/config`, which isn't tracked), so it can't be committed. It does apply across all worktrees of a clone, so the command is run once per machine. Document alongside existing one-time setup steps.

### 2. Tmux runtime — inject env var

`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts:95-110`

```ts
`zsh -l -c 'export SINGULARITY_CONVERSATION_ID=${conversationId}; ${CLAUDE}'`
```

Intent: inherited by the Claude process, any child shells, and any `git commit` it runs. Existing conversations don't need migration.

**⚠️ Risk to verify during implementation — env var inheritance is not guaranteed end-to-end.** Several steps can scrub it:

- `zsh -l` (login shell) re-sources `/etc/zprofile`, `~/.zprofile`, `~/.zshrc`. If any of those `unset` the var or run a plugin that does, it's gone.
- Claude Code may spawn subshells through a wrapper that normalizes env (e.g. some sandbox modes).
- Tmux's `update-environment` option controls which vars get refreshed on attach; on detach/reattach the pane's env is preserved, but `tmux send-keys` of a new shell may not inherit.
- `sudo`, `env -i`, or any tool that strips env would break the chain.

**If inheritance fails: stop and redesign with the user.** Do not invent a workaround during implementation. The verification step 3 (raw `git commit` in the pane) is the canary — if the trailer doesn't land, surface the failure and come back to the design table.

### 3. Schema — `plugins/conversations/server/schema.ts`

- Add `"pushed"` to `ConversationStatusSchema` enum (line 6-12).
- `pushes.sha` gets a unique index (prevents double-inserts between backfill + live watch).
- Add `pushes.pushId text not null` — the per-push ULID. Indexed, not a FK (the id only lives in git).

Run `./equin build` to regenerate migrations.

### 4. CLI — stamp `Singularity-Push` during rebase

`cli/src/commands/push.ts`

- The `git commit -m` at line 97 no longer needs explicit stamping — the git hook (§1) handles `Singularity-Conversation`. Drop any per-commit stamping logic from the CLI.
- Generate a push id once per invocation: `const pushId = ulid()` (or crypto.randomUUID — any unique token).
- Replace the current rebase at line 139:

  ```ts
  const exitCode = await exec([
    "git", "rebase", "main",
    "--exec",
    `git commit --amend --no-edit --trailer Singularity-Push=${pushId}`,
  ]);
  ```

  `--exec` runs after each picked commit, so every commit on the rebased branch carries the push id. Rebase already rewrites shas; marginal cost is zero.

- `--from-main` flow (line 112-131): no rebase step, but it's a single commit. Add `--trailer Singularity-Push=...` directly to that commit:

  ```ts
  await exec(["git", "commit", "-m", opts.message, "--trailer", `Singularity-Push=${pushId}`]);
  ```

- If `$SINGULARITY_CONVERSATION_ID` is not set, commits still get the `Singularity-Push` trailer but no `Singularity-Conversation`. The watcher skips those (no conversation to attribute to).

### 5. Server — main-ref watcher in every namespace

New file: `plugins/conversations/server/internal/push-watcher.ts`. **Runs in every server, not gated to main.**

- **Backfill on start**: `git log main --format='%H%x00%B%x00'` (NUL-delimited so bodies with newlines are safe). Parse trailers with `git interpret-trailers --parse`. For each commit, upsert `pushes` row by unique sha with (conversationId, sha, message, pushId, createdAt from commit). If a conversation id in the trailer does not match a row in *this* server's conversations table, skip silently — other servers attribute their own conversations.
- **Live watch**: 1s poll of `git rev-parse refs/heads/main`. On change, process `git log <prev>..<new>` the same way. Track `<prev>` in memory (reset to current HEAD on startup after backfill).
- **Conversation status flip**: after inserting a `pushes` row, set the attributed conversation's status to `pushed` *only if that conversation exists locally*.
- **SSE broadcast**: extend `protocol.ts:3-10` with a `"pushed"` event (conversationId, pushId, sha) for live UI updates. Reuse the existing status broadcast for the enum change.

Cross-worktree implication: conversations live in their creating server's DB, so only that server will have a row to flip. Other servers parse the same trailers and no-op on conversation attribution (ok), but still have full git-level data available locally if they later want to display commits across namespaces. This is a bonus, not a requirement.

### 6. Status precedence — `pushed` is terminal from poller's POV

`plugins/conversations/server/poller.ts:9-12`

```ts
if (current === "pushed") return; // terminal — don't downgrade from runtime signals
```

Only the push-watcher sets `pushed`. Re-push is a no-op on status.

### 7. UI — status badge + push grouping

- `plugins/conversations/plugins/conversation-view/plugins/status/web/StatusBadge.tsx`: add color/label for `pushed`.
- Push-list UI (future, out of scope for this plan): group `pushes` rows by `pushId` to render a single block per push. The schema is ready.

## Critical files

- `.githooks/prepare-commit-msg` — **new**, committed, executable
- `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts:95-110` — env var injection
- `plugins/conversations/server/schema.ts:6-44` — enum + sha unique + pushId column
- `plugins/conversations/server/poller.ts:9-12` — `pushed` precedence
- `plugins/conversations/server/internal/push-watcher.ts` — **new**, runs in every server
- `plugins/conversations/server/protocol.ts:3-10` — SSE event
- `cli/src/commands/push.ts:97, 112-131, 139` — push-id, rebase --exec, --from-main trailer
- `plugins/conversations/plugins/conversation-view/plugins/status/web/StatusBadge.tsx` — badge color
- Bootstrap step (in `./equin build` or a `postinstall` script): `git config core.hooksPath .githooks`

## Verification

1. `./equin build` applies migration, restarts all servers with watcher + tmux env injection + hooks path set.
2. Create a new conversation. `echo $SINGULARITY_CONVERSATION_ID` inside its pane prints the id.
3. `git commit -m "test"` directly in the pane (bypassing CLI): `git log -1 --format=%B` shows `Singularity-Conversation:` trailer from the hook.
4. `./equin push -m "feature"`: `git log main -<N> --format=%B` shows every commit from this push carries both `Singularity-Conversation` (from hook) and `Singularity-Push` (from rebase --exec) with the same push id.
5. UI: source conversation flips to `pushed` within ~1s; rows in `pushes` table carry matching `pushId`.
6. **Cross-namespace**: open the app at `http://<worktree>.localhost:9000`. Its server's DB contains the same `pushes` rows (attributed to its own conversations where present), confirming non-main servers derive independently.
7. Backfill: stop a server, push from another conversation, restart — the push appears in the restarted server without a live tick.
8. Negative: commit from a shell without the env var — no trailer, no `pushes` row, no error.
9. Multi-agent in one worktree (future-proofing): two conversations committing on the same branch each have their commits attributed correctly by the per-commit `Singularity-Conversation` trailer.
