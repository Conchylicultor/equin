# Retiring `conversations.status-shadow-audit`: what its reports say first

## Context

The 1 s `conversations.poller` was replaced by push signals plus a 1-minute sweep
(`research/2026-10-02-conversations-poller-push-status.md`, landed 2026-10-02 16:12). Its old tick
still runs on main as `conversations.status-shadow-audit`
(`plugins/conversations/server/internal/status-shadow-audit.ts`). It writes nothing. Each second
it runs a `ps`, a `tmux list-panes` and a capture of every pane, and it files a
`StatusSignalMissed` report when its verdict differs from the DB row for at least 2 s. It also
holds a temporary entry on the `defineTimer` allowlist
(`plugins/infra/plugins/background/plugins/timer/lint/index.ts`).

The rule was: delete it after about a day if Reports is empty. **Reports is not empty.** Main has
one deduplicated `StatusSignalMissed` row (`report-1791007226575-fwzi89`, count 27, from
2026-10-03 06:00 to 2026-10-06 22:53). Main's backend log (`~/.singularity/logs/gateway/singularity.log`)
has 36 audit lines. Each one is classified below before anything is deleted.

## What the 36 hits are

| Class | Hits | Verdict the audit wanted | Root cause | Missed signal? |
|---|---|---|---|---|
| **B: non-agent tmux sessions** | 23 | everything on `spike-auq` / `spike-auq-b` (adopt, working, waiting, question, hibernate) | **Bug.** `listPanes()` filters with `-f '#{r:^(conv\|claude)-,#{session_name}}'`. `r:` is not a tmux modifier: it expands to the literal text, which is non-empty, so the filter keeps **every** pane (verified: 21 of 21 panes pass; `#{m/r:…}` is the real regex match). So `list()` (sweep and boot) sees the sessions the AskUserQuestion-relay agent started by hand. On main they were **adopted** as conversations (`spawned_by: "poller"`, attached to that agent's attempt). The signal path drops them correctly (`AGENT_SESSION_RE` in `signals.ts`), so only the sweep and the audit could see their changes. | Yes, structurally: the two filters disagree. |
| **A: `claudeSessionId` arrives late** | 7 | `patch {claudeSessionId}` on a just-launched conversation | `acceptsSessionId` refuses a candidate until its transcript exists (gate 1). The session-file write that wakes the reconcile lands just **before** the CLI creates `<sessionId>.jsonl`. Transcript birthtimes: `ab5453b8` 00:53:52 vs divergence from 00:53:53, with the last signal reconcile 2.8 s earlier; `27cbf65a` 12:45:04 vs 12:45:05. Nothing signals "the transcript now exists". The id lands only at the next session-file write (turn end) or the next sweep. | **Yes.** It is a real missing signal. |
| **C: working ↔ waiting, ~2–3 s** | 6 | `status` on real conversations, at launch (`ov6h`, `up8f`), right after a background `build`/`push` starts (`u3ra`, `m2j5` on 10-03), and at wrap-up (`m2j5` on 10-06) | For the two op cases, the op-log `requested` time (09:21:30.85, 10:24:11.79) is exactly when the divergence starts, so the op signal did fire. For `ov6h`, `event_emissions` shows the DB moved to `waiting` at 21:21:33.76, about 2.2 s after the divergence began, through a signal reconcile (not the minute sweep). These are **late** signals: FSEvents latency, the 150 ms debounce, the reconcile gate and an `inspect` all run on a host that is busy launching or building. The 2 s threshold cannot tell late from missed. The other four have no surviving evidence (`event_emissions` keeps about a day). | Not shown. The one case with evidence is late, not missed. |

## Plan

Two steps, because class C can only be settled by an audit that can tell late from missed.

### Step 1 (this task): fix A and B, and make the audit report only true misses

1. **B: one filter, stated once** (`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`).
   - Drop the tmux-side `-f` filter from `listPanes()` and filter the parsed rows in JS with
     `AGENT_SESSION_RE`, the constant the signal path already uses (`signals.ts`).
   - The two filters can then no longer disagree. That is better than fixing the format string, which
     would still be a second copy of the regex in a language no test runs.
   - An unfiltered `list-panes -a` costs nothing measurable (21 lines today).
   - Move `AGENT_SESSION_RE` next to `listPanes` (or into a tiny shared module) so both import it.
   - Unit test the row parser: a `spike-auq` row is dropped, `conv-…` and `claude-…` are kept.
   - Leave the already-adopted `spike-auq*` rows alone. They are `done`.
2. **A: a transcript-created wake** (`plugins/conversations/plugins/transcript-watcher/server/internal/watcher.ts`
   and `plugins/conversations/server/internal/status-reconciler.ts`).
   - transcript-watcher already subscribes to `CLAUDE_PROJECTS_DIR`. Add a generic export,
     `onTranscriptCreated(listener: (sessionId: string) => () => void)`. It is fed from the same
     `onChange` batch with the `create` events of a top-level `<uuid>.jsonl`, before room dispatch.
     It knows no consumer.
   - In the reconciler, `planFor` records a candidate refused **because no transcript exists** in a
     `pendingSessionCandidates: Map<sessionId, conversationId>`. That needs `acceptsSessionId` to
     return the refusal reason (`"accepted" | "no-transcript" | "foreign"`) instead of a boolean.
   - The map is bounded by live candidates. An entry is dropped when its candidate is accepted, when
     the row stops being live, or when a newer candidate replaces it.
   - On a created transcript whose id is pending, call `requestStatusReconcile([conversationId])`.
   - `conversations/server` already imports transcript-watcher, so this adds no new edge.
   - Tests: a `planFor`/gate unit test for the reason, and a watcher test that a create event reaches
     the listener once.
3. **Audit: report a miss, not a late signal** (`status-shadow-audit.ts`).
   - When a divergence **resolves**, the audit checks `lastSignalReconcileAt(id) >= divergence.since`.
     If that holds, the fix was signal-driven: log one line with the latency and file nothing. If it
     does not, the sweep fixed it: file the `StatusSignalMissed` report then.
   - A divergence still open after 90 s (past one sweep) is also a miss.
   - Drop the 2 s report trigger.
   - The report data gains `resolvedBy` and `divergedForMs`.
   - Keep it minimal: it is temporary code. Put the late/missed/open decision in a small pure
     function, so the one rule step 2 relies on is unit tested.

`./equin build`. After the user's review, `./equin push`. Main then runs the corrected
audit.

### Step 2 (follow-up task, about a day after step 1 is on main): delete the audit

**Done 2026-10-08.** Step 1 landed on main at 2026-10-07 02:49 CEST. In the ~39 h after it, there were no new
`StatusSignalMissed` reports (the only row, `report-1791007226575-fwzi89`, was last seen at 01:48 CEST,
before the push). The log showed 19 late fixes, every one a `status` patch fixed by a signal in 2–6 s.
The audit, `shadow-audit-step.ts` and its test, the `timer/no-unlisted-timer` exemption (which by then
lived in `plugins/conversations/exempt/index.ts`), `lastSignalReconcileAt`, `collectLive`'s
`report` option (only the audit turned it off) and the reconciler exports only the audit imported are
deleted.

If Debug → Reports shows no new `StatusSignalMissed` and the late-latency log lines stay at a few
seconds, delete:

- `status-shadow-audit.ts`, plus its import, timer registration and `startStatusShadowAudit()` call in
  `plugins/conversations/server/index.ts` (lines 27–29, 160, 165);
- the allowlist entry and comment in `plugins/infra/plugins/background/plugins/timer/lint/index.ts`;
- `lastSignalReconcileAt` and its writer in `status-reconciler.ts` (lines 379–381, 446). The audit is
  its only reader.
- Then update the "missed signal" row in the 2026-10-02 plan's Verification 4, the `conversations`
  CLAUDE.md, and `./equin build` for the docs regen.

A new report means one more class to understand and cover first, as above. File step 2 with
`add_task` at the end of step 1, depending on nothing, with this doc as its context.

## Verification

- `./equin test plugins/conversations/plugins/runtime-tmux plugins/conversations/plugins/transcript-watcher plugins/conversations`.
- B on this worktree's deploy:
  - `tmux new-session -d -s spike-check claude` (or any process), then confirm no
    `spike-check` row appears in this worktree's DB through `query_db`;
  - Adoption is main-only, so also confirm that `list()`'s map lacks the session, through the unit
    test.
  - Kill the session afterwards.
- A: launch a fresh conversation on this worktree's deploy. `claude_session_id` should be set within
  about 1 s of the transcript's birthtime (`stat -f %SB`), not at turn end.
- Audit: it runs on main only, so it cannot be exercised on a worktree deploy. Pull the
  resolve/classify step into a pure function (divergence + `lastSignalReconcileAt` + now →
  `late` / `missed` / `open`) and unit test it. Read the real output on main after the push.
