# Fix: `claudeSessionId` stuck at NULL breaks Push & Exit

## Context

Push & Exit shipped (see `research/2026-04-17-plugins-push-and-exit-v2.md`)
and works end-to-end: the prompt is sent, Claude pushes, Claude ends its
final message with `PUSH_EXIT_CLEAN`. But the UI shows the "missing" branch
("Couldn't find Claude's final message in the transcript.") even though
Claude emitted the sentinel correctly.

### Confirmed diagnosis

For the offending conversation `claude-1776427064-59ei`:

- The Claude Code JSONL has the final assistant event with
  `stop_reason: "end_turn"` and the text
  `"Push succeeded — branch merged into main cleanly, all checks passed.\n\nPUSH_EXIT_CLEAN"`
  (sessionId `a9217c2d-9ae8-4dd8-b519-476f2fab15f0`).
- `~/.claude/sessions/55330.json` (the pane's pid) contains the correct
  `sessionId`.
- **But** `SELECT claude_session_id FROM conversations WHERE id = '…'`
  returns `NULL`.

So `handleListTurns` short-circuits on `if (!row.claudeSessionId) return
Response.json({ turns: [] })`. The client then can't find a final
`end_turn` assistant turn and falls into the "missing" branch.

Many existing conversations in the DB also have `NULL` — this is a
long-standing latent bug that only now has a user-facing symptom.

### Root cause

`plugins/conversations/plugins/runtime-tmux/server/internal/claude-session.ts`
caches **both** positive and negative results:

```ts
const pidCache = new Map<number, string | null>();

export async function resolveClaudeSessionId(panePid: number) {
  if (pidCache.has(panePid)) return pidCache.get(panePid)!;
  let sessionId = await readSessionId(panePid);
  // … (pgrep children fallback)
  pidCache.set(panePid, sessionId);   // stores null too
  return sessionId;
}
```

The poller calls `resolveClaudeSessionId(panePid)` on every tick. If the
first call happens before Claude has created `~/.claude/sessions/<pid>.json`
(there's a brief race at conversation launch), `null` is cached for that
pid. Every subsequent tick returns the cached `null` without re-reading the
file, so the DB column is never populated — even after Claude starts
writing the sessions file and its JSONL transcript.

`forgetPid` exists but is only called when a pane dies, so a long-lived
pane with an early-null cache never recovers.

## Fix

Mirror the positive-only caching pattern already used in
`plugins/conversations/server/internal/claude-transcript.ts`: only cache
successful resolutions. Null results fall through and retry on the next
poller tick.

### File to change

`plugins/conversations/plugins/runtime-tmux/server/internal/claude-session.ts`

```ts
const pidCache = new Map<number, string>();   // positive-only

export async function resolveClaudeSessionId(
  panePid: number,
): Promise<string | null> {
  const cached = pidCache.get(panePid);
  if (cached) return cached;

  let sessionId = await readSessionId(panePid);
  if (sessionId == null) {
    for (const child of await pgrepChildren(panePid)) {
      sessionId = await readSessionId(child);
      if (sessionId) break;
    }
  }
  if (sessionId) pidCache.set(panePid, sessionId);
  return sessionId;
}
```

`forgetPid` can stay (cheap; keeps the API symmetric).

Update the comment block above the function; the "unchanged pid re-uses
prior result (including null for 'not found')" line is now wrong.

### Verification

1. Manually clear the stuck row so we can watch the poller repopulate it:
   ```sql
   -- already NULL; this is just a reset if needed during testing
   UPDATE conversations SET claude_session_id = NULL
   WHERE id = 'claude-1776427064-59ei';
   ```
2. `./equin build` — server restart clears the in-memory pidCache.
3. Wait one poller tick (~1s) and re-query the row:
   ```bash
   psql -d claude-1776411743-en61 -tAc \
     "SELECT claude_session_id FROM conversations WHERE id = 'claude-1776427064-59ei'"
   # → a9217c2d-9ae8-4dd8-b519-476f2fab15f0
   ```
4. In the UI, click **Push & Exit** on a fresh conversation and confirm the
   CLEAN path closes cleanly (toast + nav to `/`) and the FLAG path opens
   the sheet.

## Out of scope

- No changes to the push-and-exit component or the generic
  turn/turns/close primitives. The race that remains in theory (JSONL
  flush vs. status flip) didn't happen in this incident — the JSONL had
  the full `end_turn` event before we fetched. If it ever does bite, the
  minimal retry loop discussed earlier (up to 5× / 500ms in the
  `fetching` effect) can be added as a separate change.
