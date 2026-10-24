# Turn-emitter: push-based activation instead of a 5 s poll

## Context

`plugins/conversations/server/internal/turn-emitter.ts` runs `defineTimer("conversations.turn-emitter")` every 5 s. Each tick calls `listConversationsForInfra()` (every non-`done` conversation) only to diff the active set against its in-memory `subscriptions` map and call `watchTranscript` / unsubscribe. The transcript reads themselves are already push-driven (transcript-watcher), so the timer exists only to learn about status changes. That is:

- polling (CLAUDE.md "No polling"); the lint allowlist in `plugins/infra/plugins/background/plugins/timer/lint/index.ts` lists it as "REAL polling … until replaced by a push signal";
- a steady DB read per backend, every 5 s;
- up to 5 s of extra delay before the first end-of-turn of a newly active conversation can be detected.

The app already announces both kinds of change:

| Change | Event | Where emitted |
|---|---|---|
| conversation inserted (`starting`, or the adoption's live status) | `conversation.created` (`conversationCreated`, conversations plugin) | on the insert's tx: `commitConversation` (lifecycle.ts) and poller orphan adoption |
| status update / `gone` / close / hard delete | `conversation.statusChanged` (`conversationStatusChanged`, tasks-core `tables-events.ts`) | `emitConversationStatusChange` after commit, from all four status writers in `tasks-core/server/internal/mutations/conversations.ts` (`updateConversation`, `markConversationGone`, `markConversationClosed`, `deleteConversationRow`, which reports `done`) |

Every `_conversations.status` write in the repo goes through those functions; I checked with `rg "update(_conversations)"`. Nothing subscribes to `conversation.statusChanged` today; its "sole consumer" comment is stale.

## Design

Make the turn-emitter a **per-conversation reconciler driven by the events**, plus **one reconcile at boot**.

### 1. `reconcile(conversationId)`: idempotent, reads the DB for the truth

The event payload only wakes the handler. The handler does not trust the `status` it carries; it re-reads the row:

```
read status of conversationId (one PK read)
active = row exists && isActiveStatus(row.status)
active && !subscribed  → subscriptions.set(id, subscribeToConversation(id))
!active && subscribed  → unsub(); subscriptions.delete(id)
```

Out-of-order, duplicate or replayed-after-restart event jobs then cannot corrupt the map. Every job converges on the current DB state.

### 2. One job, two triggers

New `defineJob("conversations.turn-emitter.reconcile")`, modelled on `notifyConversationCreatedJob` (`plugins/conversations/server/internal/notify-created-job.ts`):

- `hold: "instant"`, `input: z.object({})`, `dedup: "none"`;
- `event: z.object({ conversationId: z.string() }).passthrough()`;
- `run: ({ event }) => reconcile(event.conversationId)`.

It is bound with two static `Trigger({ on, do, with: {}, oneShot: false })` contributions in `plugins/conversations/server/index.ts`, beside the existing ones: one `on: conversationCreated` and one `on: conversationStatusChanged` (already exported from `@plugins/tasks/plugins/tasks-core/server`).

The job runs in this backend's own graphile worker, because each backend has its own DB and queue. It can therefore mutate the module-level `subscriptions` map directly. A write made by another process (CLI, MCP) also reaches us, because the trigger is a row in our DB.

### 3. Boot reconcile, once

In `onReady`, `startTurnEmitter()` makes one `listConversationsForInfra()` read and subscribes to each active id. This replaces the timer's `immediate: true` first tick. The subscriptions are in memory, so they are lost on every restart, and this rebuilds them. A transition missed while the process was down is fixed by the same read. A query failure here throws (fail loudly). The old code swallowed transient errors because a later tick would retry; with no later tick, swallowing would leave the emitter silently empty.

### 4. Serialize every reconcile

The boot reconcile and the event jobs can interleave: the boot read sees X active, X→done's job unsubscribes, and then boot applies its stale read and resubscribes X for good. To prevent this, all reconciles (boot and per-id) run through **one promise chain** in turn-emitter.ts, and **each reads the DB inside its turn**. A job queued behind the boot reconcile then reads fresher state than boot did, so the last writer is always the freshest read. There is no in-flight concurrency beyond one PK read per event, so a single chain costs nothing.

### 5. Delete the timer

- Remove `turnEmitterTimer`, `POLL_MS` and `tick()`. Drop `turnEmitterTimer` from `register` in `conversations/server/index.ts` and add the new job there.
- Remove `"plugins/conversations/server/internal/turn-emitter.ts"` from the `no-unlisted-timer` ignore list. Reword that block's comment so it names only the poller (tmux sessions).
- Fix comments that name the turn-emitter as a poller caller: `listConversationsForInfra` in `tasks-core/server/internal/queries/conversations.ts` (callers become "poller; turn-emitter boot reconcile"), and the stale "No filter columns: the sole consumer (queue pin revalidation)…" comment on `conversationStatusChanged`, which should name the turn-emitter.
- `stopTurnEmitter` currently has no callers. Keep it (unsubscribe all) only if it is still referenced after the change; otherwise delete it.
- Leave `subscribeToConversation`, `hasPendingTrigger` (the seed-read replay for durable waiters) and `emitEndTurn` unchanged.
- The autogen docs (`plugins/conversations/CLAUDE.md`, `docs/plugins-details.md` list `defineTimer('conversations.turn-emitter')`) regenerate on `./equin build`.

### Residual risk (unchanged in kind)

`emitConversationStatusChange` runs after the write commits, not on its tx. If the process dies between the commit and the emit, the transition is lost until the next restart, and the boot reconcile then catches it. A lost `→done` only leaves a watcher on a dead transcript (harmless). A lost `→active` is unlikely, because the conversation was already subscribed from its `created` event, which is on the insert's tx. Moving the status emits onto the write's tx is a separate tasks-core change; I'm not including it here.

## Files

- `plugins/conversations/server/internal/turn-emitter.ts`: rewrite the activation half (reconcile, serialized chain, job, boot start).
- `plugins/conversations/server/index.ts`: two `Trigger` contributions, register the job, drop the timer.
- `plugins/infra/plugins/background/plugins/timer/lint/index.ts`: remove the allowlist entry and update the comment.
- `plugins/tasks/plugins/tasks-core/server/internal/queries/conversations.ts`, `tables-events.ts`: comment fixes only.

## Verification

1. `./equin build` (background). The type-check and the timer lint pass, and the docs regenerate without the timer.
2. Debug → Background activity: `conversations.turn-emitter` is gone from Timers. `conversations.turn-emitter.reconcile` appears under jobs, triggered by `conversation.created` / `conversation.statusChanged`.
3. Launch a conversation on the worktree deploy and let it finish a turn. Then, with `query_db` on the worktree DB:
   - `event_emissions` shows `conversation.created` / `conversation.statusChanged` and the reconcile jobs that ran;
   - a `conversation.turnCompleted` emission appears right after the turn ends, with no 5 s lag.
4. Restart the backend while a conversation is active (rebuild), then have it finish a turn. It is still detected, which confirms the boot reconcile and the seed replay.
5. Close the conversation. Its reconcile job runs and unsubscribes (add a log line or check the transcript-watcher room count if exposed).
