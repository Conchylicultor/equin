# Mail: On-Demand Search — Pull Older-Than-Window Mail Into the Local Mirror

## Context

Mail sync only mirrors message **envelopes within a recent window**: `backfill.ts` calls
`listMessages(token, { q: \`newer_than:${BACKFILL_WINDOW_DAYS}d\` })` (30 days, capped at
`MAX_BACKFILL_MESSAGES = 1500`). Mail older than that window is **not in local Postgres**, so it is
invisible to the client — there is no way to find or open an older email. Bodies for windowed mail
hydrate lazily on open (`POST /api/mail/hydrate`).

We need **on-demand search**: the user types a query, we hit Gmail `messages.list?q=<query>` (whose
server-side search spans the *entire* mailbox, not just the synced window), **fold** the matching
messages into the mirror via the existing idempotent upserts, and render them like any cached message.
Bodies still hydrate lazily on open.

This is **remote Gmail search folded into the mirror** — deliberately distinct from a local full-text
search over `search_documents`, which can only ever find rows already mirrored (useless for
older-than-window mail).

Additional finding: the Mail app currently has **no search box, no message list, and no reader** — it
is only a capability-driven empty-state landing. So this task ships both the backend pull *and* a
minimal, professional surface to trigger it and read results, or the feature is untestable and unusable.

## Approach

Two halves, split on the plugin boundary:

- **Backend ingestion** — extend the existing `sync` plugin (same family as backfill/delta/hydrate).
- **UI** — a new self-contained plugin `plugins/apps/plugins/mail/plugins/search/` (web-only) that
  consumes the sync endpoints and registers panes into the existing Miller-columns router.

### Part A — Backend (in `plugins/apps/plugins/mail/plugins/sync/`)

**A1. NEW `server/internal/remote-search.ts`** — `remoteSearch(q, pageToken?)`:
1. Trim `q`; empty → `{ results: [] }` (no Gmail call).
2. Get token via the same helper backfill/hydrate use (`requireGmailToken()` / token+account lookup —
   confirm exact name while implementing).
3. Resolve `accountId` from the account row; **no account → `HttpError(409, "Connect Gmail …")`**
   (search folds into an existing mirror; it does not bootstrap an account).
4. `listMessages(accessToken, { q, pageToken, maxResults: 25 })` — pass `q` on every page.
5. `fetchEnvelopes(accessToken, ids)` (reuse verbatim — 404-tolerant, semaphore 8, metadata format).
6. `upsertMessageEnvelope(accountId, m)` for each fetched (idempotent fold; preserves cached bodies).
7. Read `_mailMessages` rows back for those ids, **reordered to Gmail's returned order** via a
   `Map<id,row>` (a bare `inArray` scrambles order). Drop missing/404 ids.
8. Return `{ results, nextPageToken }`.

**A2. EDIT `core/endpoints.ts`** — add `mailSearchEndpoint`:
`GET /api/mail/search`, query `{ q: string; pageToken?: string }`,
response `{ results: MailMessageSchema[]; nextPageToken?: string }`, `concurrency: 4`, `dedupe: true`.
Reuse `MailMessageSchema` (already imported) rather than a bespoke lean schema — body columns are
`null` for envelopes (cheap), and it matches the hydrate wire schema.

**A3. EDIT `core/index.ts`** — re-export `mailSearchEndpoint`.
**A4. EDIT `server/internal/handlers.ts`** — `handleMailSearch = implement(mailSearchEndpoint, ({query}) => remoteSearch(query.q, query.pageToken))`. Re-map a disconnected-token error to `HttpError(409)`.
**A5. EDIT `server/index.ts`** — register `[mailSearchEndpoint.route]: handleMailSearch` in `httpRoutes`.
**A6. EDIT `sync/CLAUDE.md`** — note the on-demand-search endpoint next to hydrate/sync; update the
"window ≠ whole mailbox" limitation.

### Part B — UI (new `plugins/apps/plugins/mail/plugins/search/`, web-only)

Mirror `sync-status` as the minimal-plugin template (`package.json` + `web/index.ts`).

- **`web/panes.tsx`** — two panes via `Pane.define`:
  - `mailSearchPane` (`segment: "search"`, width ~480): `SearchInput` (debounced ~250ms) in a sticky
    top region + results list. Data via `useEndpoint(mailSearchEndpoint, {}, { query: { q },
    enabled: q.trim().length > 0 })`. States: empty-query / loading (skeleton-rows) / no-matches /
    error (`Placeholder tone="error"` for the 409). `nextPageToken` → optional "Load more".
  - `mailMessagePane` (`segment: "m/:messageId"`, width ~640, `defaultAncestors: [mailSearchPane]`,
    `input: MailMessage`): the reader.
- **`web/components/mail-search-row.tsx`** — one result row via `Row` + `Frame`/`Stack` + `Text` +
  `RelativeTime` + `StatusDot`. Sender · subject · snippet · relative date · unread dot · star.
  Opens `mailMessagePane` via `openPane(..., { mode: "push", side: "right", input: m })`.
  Label/attachment chips deferred (labels are a join table; `hasAttachments` unknown pre-hydration).
- **`web/components/mail-message-reader.tsx`** — hydrate via `useEndpointMutation(mailHydrateMessageEndpoint)`
  fired in an effect keyed on `messageId`; paint the header optimistically from the pane `input`
  envelope. Render `bodyText` in a `whitespace-pre-wrap` prose block. **Never render `bodyHtml`**
  (sanitization rabbit hole) — if only HTML exists, show a graceful "plain-text unavailable" note.
  Attachment filenames as `Badge` chips (download deferred).
- **`web/components/mail-search-sidebar.tsx`** — a single `Mail.Sidebar` entry (`Search`, `MdSearch`)
  that opens `mailSearchPane`.
- **`web/index.ts`** — contribute `Mail.Sidebar(...)` + `Pane.Register` for both panes.
- **`CLAUDE.md`** — standard plugin doc.

### Part C — one shell edit

**EDIT `plugins/apps/plugins/mail/plugins/shell/web/components/mail-layout.tsx`** — pass
`sidebarSlot={Mail.Sidebar}` to `AppShellLayout` (mirrors pages' `sidebarSlot={Pages.Sidebar}`) so the
new search entry renders. The `Mail.Banner` header + Miller body are unchanged.

## Key reused primitives

- `store.ts` `upsertMessageEnvelope` / `fetch-envelopes.ts` `fetchEnvelopes` / `gmail-api` `listMessages`
  — the exact backfill loop, minus the `newer_than` window.
- `hydrate.ts` `hydrateMessage` + `mailHydrateMessageEndpoint` — reader body, no new backend.
- `endpoints` primitive (`defineEndpoint`/`implement`/`useEndpoint`/`useEndpointMutation`).
- `pane` (`Pane.define`, `PaneChrome`, `openPane`), `miller` layout, `app-shell` (`AppShellLayout`).
- CSS/layout primitives: `Row`, `Text`, `Stack`, `Badge`, `Placeholder`, `Loading`, `RelativeTime`,
  `StatusDot`, `Sticky`, `SearchInput`.

## Verification

1. `./equin build` + `./equin check` (lint gates pass — all layout via primitives, all
   fetch via `useEndpoint`/`useEndpointMutation`).
2. Connect Gmail; let backfill create the account + watermark.
3. `query_db` **before**: confirm a term known only in >30-day-old mail is absent from `mail_messages`.
4. UI: `/mail` → sidebar **Search** → type the term → old message appears as a row.
5. `query_db` **after**: the envelope is now in `mail_messages` (`body_text`/`body_fetched_at` null)
   with a `mail_threads` stub — confirms the fold.
6. Open the row → reader hydrates (`POST /api/mail/hydrate`) → `body_text`/`body_fetched_at` populated;
   re-open is instant (cache hit, no Gmail call).
7. Idempotency: search twice → no duplicate rows.

## Risks / follow-ups

- **Rate limits / latency**: ≤25 metadata gets per search (semaphore 8), `concurrency: 4`,
  `dedupe: true`, client debounce ~250ms. Essential — without debounce every keystroke round-trips.
- **Disconnected state**: `HttpError(409)` → clean `Placeholder`, not a raw 500.
- **Read-back ordering** is load-bearing (Map reorder to Gmail relevance order).
- **Follow-ups (file as tasks)**: thread-grouping of results; label/attachment chips on rows;
  attachment blob download in the reader; infinite-scroll pagination; optional full-text index of
  folded messages into `search/engine`; safe HTML body rendering (sanitized iframe).
