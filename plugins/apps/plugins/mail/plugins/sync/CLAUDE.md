# sync

The Gmail **sync engine** — the only genuinely new code in the Gmail-client
vision (everything else composes existing primitives). It fills the otherwise
empty `mail-core` tables by mirroring a Gmail mailbox into Postgres: a bounded
backfill, incremental delta, and a bounded full-resync fallback.

## On-demand model (Superhuman-style local cache)

The mailbox is **not** mirrored in full, and message **bodies are never fetched
eagerly**. Two independent bounds make connect feel instant even on a huge
mailbox (this account had 58k messages, which the old eager full-body crawl
could never back up inside Gmail's history window — it wedged in a resync loop):

1. **Bounded window.** The backfill only mirrors message ENVELOPES within a
   recent window (`newer_than:${BACKFILL_WINDOW_DAYS}d`, hard-capped at
   `MAX_BACKFILL_MESSAGES` — both in `core/config.ts`). Older mail simply isn't
   in the local mirror until on-demand search pulls it in (a later phase).
2. **Metadata-only ingestion.** Envelopes are fetched with Gmail
   `format=metadata` (headers + snippet + labels, no body) — cheap and fast.
   The full MIME **body + attachments are hydrated lazily on first open** and
   cached forever after (`POST /api/mail/hydrate` → `hydrate.ts`). A message row
   is an envelope-only stub (`body_fetched_at` null, body null) until then.

Depends on `gmail-api` (the stateless token-in/JSON-out REST client) and
`mail-core` (the persisted tables + `requireGmailToken()`). MIME parsing is a
pure, sync-internal concern (`server/internal/mime.ts`, with a co-located
`bun:test`), not a reuse boundary.

## Sync state machine (`mail_sync_state.status`)

```
idle → (bootstrap) → backfilling → (window done / cap hit) → delta ⇄ (404 expiry) → backfilling
```

- **`historyId`** is the watermark — the Gmail mailbox revision the local mirror
  is current to. `getProfile().historyId` is captured at bootstrap as the
  *initial* watermark; the backfill then **renews it on every page** by consuming
  `history.list` from the current watermark forward (`applyHistorySince` in
  `history-sync.ts`). This keeps the watermark within one page-interval of fresh,
  so a long backfill can never outlive Gmail's history-retention window — the
  root cause of the stale-historyId resync loop. It also captures in-flight
  additions/label-changes/deletions that `messages.list` (newest-first, paging
  downward) would otherwise skip, so nothing is lost. (Capturing a *fresh*
  `profile.historyId` at completion instead would be **unsafe**: `messages.list`
  is not a point-in-time snapshot, so it misses messages that arrive during
  backfill, and a post-backfill watermark would start the first delta past them.)
- **`lastFullSyncAt` / `lastDeltaSyncAt`** are observability timestamps.
- The backfill **cursor** (Gmail `pageToken`) lives in the **job input**, not the
  DB — durable in the graphile row, so crash recovery resumes the exact page with
  no schema column.

## Live sync state (`mailSyncStateServed`)

The `mail_sync_state` rows reach the UI as the `mailSyncState` live value,
declared in `mail-core` (the leaf every mail plugin imports) and served here,
beside the jobs that write it: `serveValue(mailSyncState, { source: "db",
unbounded: { reason }, loader })` in `server/internal/resource.ts` (one row per
connected account; the app is single-account today). Every write the engine
makes — progress, a recorded error, a retry's reset — recomputes and pushes it
through the DB change-feed, so nothing here calls `notify`. `sync-status` folds
the rows into the banner and rail dot.

## The four jobs + the manual endpoint

- **`mail.backfill`** (`backfill.ts`) — one **windowed** `messages.list` page per
  run (`newer_than:${BACKFILL_WINDOW_DAYS}d`): `fetchEnvelopes` (metadata-only,
  404-tolerant) → `upsertMessageEnvelope` (envelope-only, no body); then **renews
  the watermark** for the page (`applyHistorySince` from the current `historyId`,
  persisting the advanced value); re-enqueues itself for the next page **while the
  window has more pages AND the `MAX_BACKFILL_MESSAGES` cap is not hit** (the
  running count rides in the job input). Flips `status` to `delta` as soon as
  either bound trips. Dedup keyed by `accountId` (one chain per account). A
  permanent permission/contract failure (`GmailApiError` 400/401/403) throws
  `NonRetryableError` so it dead-letters after one attempt instead of burning the
  retry budget; transient errors retry the page (upserts are idempotent). A
  stale-watermark 404 during renewal is extremely narrow (the job stalled longer
  than Gmail's history window *between two pages*); it re-arms from a fresh
  `profile.historyId` and continues (logged to `mail-sync`).
- **`mail.delta`** (`delta.ts`) — paginates `history.list` from the watermark,
  collects records, advances `historyId`. On a stale-watermark 404
  (`GmailHistoryExpiredError`) it re-enters `backfilling` from a fresh profile
  `historyId` and enqueues a backfill (bounded full resync). **Label changes and
  new messages are applied by re-fetching the affected ENVELOPES via
  `fetchEnvelopes` (metadata-only, 404-tolerant) and re-upserting with
  `upsertMessageEnvelope`** (the envelope upsert reconciles labels + flags +
  thread and PRESERVES any already-cached body) rather than hand-patching deltas
  — simpler and idempotent. A message that 404s on re-fetch (deleted after its
  history record) is reconciled as a deletion, so one vanished message never
  aborts the pass (the old all-or-nothing `batchGetMessages` dead-lettered the
  whole sync on a single deleted message — the root cause of the wedged
  `unknown`-error account). Dedup keyed by `accountId`. Consecutive 404-expiry resyncs are
  counted on `mail_sync_state.resyncCount`; after `MAX_CONSECUTIVE_RESYNCS` (3)
  consecutive expiries with no successful delta in between (a mailbox too large to
  back up before Gmail's history window expires), the engine escalates to a
  terminal `resync_loop` error instead of looping forever. The counter resets to
  0 on any successful delta pass and on a manual retry (`kickSync`).
- **`mail.sync-tick`** (`tick.ts`) — the steady-state driver. Auto-connects once
  the Gmail toggle is on (`ensureAccount()` when no account exists), then
  enqueues a delta for every account in a `delta`/`idle` state. `singleton`
  dedup, `cron: "* * * * *"`, **main-only** (see below). A first-connect
  bootstrap failure is recorded onto the account's `mail_sync_state` row by
  `ensureAccount` (→ surfaced live on the sync-status banner) and **swallowed**
  here — consistent with the per-account "record and move on" handling — so a
  terminal connection error (api_disabled/auth) does not dead-letter the tick
  every minute; it's logged to the `mail-sync` channel for observability.

  Bootstrap (`bootstrap.ts`) creates the `mail_accounts` row from the connected
  Google email (from the OAuth identity, via `requireGmailToken()`, *without* a
  Gmail API call) **before** the first `getProfile`/`listLabels` call, so a
  bootstrap-time API failure has a real row to attach its classified error to. An
  unarmed error-placeholder row (`historyId` still null) is re-armed with a fresh
  watermark on the next successful connect, so enabling the API + "Retry now"
  recovers cleanly.
- **`mail.attachment-scan`** (`attachment-scan.ts`) — pre-populates the paperclip
  indicator WITHOUT a body fetch. Paginates `messages.list?q=… has:attachment`
  (Gmail's authoritative metadata-only "real, non-inline attachment" signal —
  id-only, no per-message GET, bounded by `MAX_ATTACHMENT_SCAN_PAGES`) and marks
  the mirrored messages' `has_attachments` via the positive-only
  `markMessagesWithAttachments` (the thread rollup derives from it). Dedup keyed by
  `accountId`. Enqueued at **backfill completion** for the full
  `BACKFILL_WINDOW_DAYS` window, and on a **delta** that added new messages for a
  short recent window (`ATTACHMENT_SCAN_DELTA_WINDOW_DAYS`). Decoupled + idempotent
  so a scan failure never dead-letters the ingestion path that enqueued it.
- **`POST /api/mail/sync`** (`handlers.ts`) — manual "connect / sync now": arms
  the account and, when already in `delta`, kicks an immediate delta. The trigger
  used by the phase-3 UI and for worktree testing (the tick is main-only and
  won't fire in a worktree). A failure whose classified code is user-actionable
  (broken connection: `auth` / `api_disabled` / `quota`) answers **409** with the
  same remediation sentence the banner shows, so the caller's auto-toast is
  readable; `unknown` — the class we failed to classify, i.e. a real bug —
  rethrows, 500s, and files a crash report. Nothing is swallowed either way: the
  raw reason is already recorded on `mail_sync_state.lastError`.
- **`POST /api/mail/hydrate`** (`handlers.ts` → `hydrate.ts`) — on-demand body
  fetch, the "fetch only when opened" half of the model. Body `{ messageId }`. If
  the message is already hydrated (or is a full-backfilled row from before on-demand sync —
  `isMessageHydrated`), it is returned straight from Postgres with **no Gmail
  round-trip** (a pure cache hit). On a cache miss it fetches `format=full`,
  `upsertMessageFull` (body + attachments + `body_fetched_at`), and returns the
  now-cached `{ message, attachments }`. The message must already exist as an
  envelope stub in the mirror (a `messageId` outside the synced window → 404).
  This is what a reading pane calls when a user opens an email.
- **`GET /api/mail/search`** (`handlers.ts` → `remote-search.ts`) — on-demand
  server-side search, the escape hatch for the bounded window. Query `?q=` (+
  optional `pageToken`). It lists one `messages.list?q=` page (25), fetches the
  matching ENVELOPES (`fetchEnvelopes`, metadata-only, 404-tolerant), FOLDS them
  into the same mirror via `upsertMessageEnvelope`, then reads the rows back and
  returns them in Gmail's order (`{ results, nextPageToken }`). Bodies still
  hydrate lazily on first open. Every write is idempotent, so a retried/paged
  search is safe. When Gmail isn't connected (no token or no account row) it
  surfaces a clean `409`. `concurrency: 4` + `dedupe` (GET) bound the fan-out.

## No-polling exception

Singularity bans `setInterval`/`setTimeout` polling. Gmail's steady-state delta
is the **sanctioned exception**: Gmail push notifications (`users.watch` →
Pub/Sub) require a public inbound HTTPS endpoint + topic that a per-worktree
backend behind the gateway cannot expose. `history.list` is pull-only — there is
no change signal to subscribe to. So the delta runs as a **scheduled
`defineJob`** (`mail.sync-tick`), not an in-process timer. The schedule is
**main-only** (`perWorktree` left unset): sync hits shared external Gmail state
and the canonical mailbox lives in main's DB, so running it per-worktree would
duplicate work and race. The manual endpoint still enqueues on the current
runtime, so the engine is fully testable inside a worktree.

## Quota ("batched")

Google's JSON multipart batch endpoint is deprecated. The engine's envelope
fetch (`fetchEnvelopes`) and the `gmail-api` `batchGetMessages` are therefore
**concurrency-bounded parallel fan-outs** (8 in flight) with exponential backoff
on 429/5xx in the shared request helper — the current recommended pattern,
respecting the per-user quota. Metadata-only + windowed ingestion also slashes
the total request/byte volume versus the old full-mailbox, full-body crawl.

## Limitations (documented, deferred)

- **Window ≠ whole mailbox.** Only envelopes newer than `BACKFILL_WINDOW_DAYS`
  (capped at `MAX_BACKFILL_MESSAGES`) are mirrored. Older mail reaches the local
  mirror on demand: `GET /api/mail/search` (`remote-search.ts`) takes an arbitrary
  Gmail query, hits `messages.list?q=`, and folds the matching older-than-window
  envelopes into the mirror (list → metadata-fetch → upsert → read-back), bodies
  still hydrating lazily on open. A background reconcile of the wider mailbox
  remains a later-phase follow-up.
- **Attachment indicator is pre-populated (paperclip), not the full list.** The
  message-level `has_attachments` flag (→ thread rollup) is filled WITHOUT a body
  fetch by the `mail.attachment-scan` job (Gmail `has:attachment`, see above), so
  the paperclip shows on unopened mail. The reader's chip list and this flag share
  ONE "real, non-inline attachment" definition — `isInlineAttachment` in
  `mime.ts`, which mirrors Gmail's `has:attachment` semantics (explicit
  `Content-Disposition: attachment` always counts, even with a `Content-ID`;
  otherwise a part is inline when it's `inline`-disposition or `cid:`-referenced)
  — so the two cannot diverge from each other. Remaining gap: deep search pages /
  older-than-window mail that no scan has covered aren't flagged until hydration.
- **Bounded resync ≠ deletion reconciliation.** The 404-expiry full resync
  re-fetches and upserts everything but does **not** detect messages deleted on
  the server during the gap (Gmail gives no deleted-set without history). A
  periodic full reconcile is a later-phase follow-up. (Per-message 404s seen
  *during* a history/backfill pass ARE reconciled as deletions — see
  `fetchEnvelopes`.)
- **Attachment blobs are not downloaded** in this phase — only metadata +
  `gmailAttachmentId` are stored (`storedAttachmentId` stays null), populated at
  hydration time. Lazy blob fetch lands with the reading pane in a later phase.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Gmail sync engine (on-demand model): a bounded, metadata-only backfill mirrors a recent window of message envelopes; history.list incremental delta keeps them fresh (with a bounded full-resync fallback on historyId expiry) via a scheduled main-only delta tick (the documented no-polling exception). Message bodies + attachments are hydrated lazily on first open and cached (POST /api/mail/hydrate). Mirrors threads/messages/labels into the mail-core tables.
- Server:
  - Contributes: `resource.declare` "mail-sync-state"
  - Uses: 21 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps/mail/mail-core` ×8
    - `apps/mail/gmail-api` ×5
    - `infra/endpoints` ×2
    - `infra/jobs` ×2
    - `database.db`
    - `integrations/gmail.isGmailEnabled`
    - `network/live.serveValue`
    - `primitives/log-channels.defineLogSink`
  - Register:
    - `defineJob('mail.backfill')`
    - `defineJob('mail.delta')`
    - `defineJob('mail.sync-tick')`
    - `defineJob('mail.attachment-scan')`
  - Resources: `mail-sync-state` (push, unbounded: one row per connected mail account — the app is single-account today)
  - Routes:
    - `POST /api/mail/sync`
    - `POST /api/mail/hydrate`
    - `GET /api/mail/search`
- Core:
  - Uses:
    - `apps/mail/mail-core.MailAttachmentSchema`
    - `apps/mail/mail-core.MailLabelRefSchema`
    - `apps/mail/mail-core.MailMessageSchema`
    - `infra/endpoints.defineEndpoint`
  - Exports (types): `MailSearchResult`
  - Exports (values):
    - `ATTACHMENT_SCAN_DELTA_WINDOW_DAYS`
    - `BACKFILL_WINDOW_DAYS`
    - `mailHydrateMessageEndpoint`
    - `mailSearchEndpoint`
    - `MailSearchResultSchema`
    - `mailSyncEndpoint`
    - `MAX_ATTACHMENT_SCAN_PAGES`
    - `MAX_BACKFILL_MESSAGES`
- Sub-plugins:
  - **`auto-resume`** — Auto-resumes Mail sync when the Gmail scope is (re)granted: an app-wide headless listener that POSTs the sync kick endpoint on the connect edge.

<!-- AUTOGENERATED:END -->
