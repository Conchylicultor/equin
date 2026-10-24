# Vision: A Gmail-class mail client, composed from equin primitives

**Status:** Vision / north-star. Per-phase design happens in each implementation task ("Plan first.").
**Date:** 2026-06-29
**Prereq landed:** `plugins/integrations/plugins/gmail/` — Gmail OAuth scope (`https://mail.google.com/`) gated behind a Settings toggle on the shared Google connection. Token obtained via `auth` (`getTokenFromCentral("google")`). This doc assumes that plumbing and builds the actual mail experience on top.

---

## 1. Vision

A full Gmail-class mail client, delivered the equin way: **not an email app written from scratch, but a thin Gmail-sync core wired into the primitives we already have.** The inbox is a `data-view`. Search is the `search/engine`. Background sync is `jobs` + `events`. Live updates are `live-state`. Compose is the `text-editor`. Attachments are `infra/attachments`. The novel surface area is deliberately small: a Gmail sync engine, a mail data model, and mail-specific UI sections.

This is also the first real test of the "Notion-like WeChat" thesis at app scale — a mail client that is itself a *composition* of marketplace-style plugins, sharing the same primitives as every other app, so that later an agent could recompose "mail + tasks + calendar" into one personal surface.

**Success looks like:** connect a Google account, the inbox backfills and stays live, you can triage with keyboard shortcuts at Gmail speed (optimistic, instant), compose/reply/forward with attachments, search with Gmail operators, and manage labels — all offline-tolerant after first warm-up.

---

## 2. Boundary: integration vs. app

Two distinct plugins, clean separation of concerns:

- **`plugins/integrations/plugins/gmail/`** (exists) — owns *"can we talk to Gmail?"*: the scope requirement, the enabled toggle, token access. No UI beyond the Settings toggle. A pure capability provider.
- **`plugins/apps/mail/`** (new) — owns *"the inbox experience"*: data model, sync, UI. **Consumes** the gmail integration's barrel for the enabled/scope signal and `auth` for the token. The app is the consumer; the integration is the capability.

This mirrors the collection-consumer separation: the app never re-implements OAuth, and the integration never knows about threads or reading panes.

---

## 3. Reuse map — what we do NOT build

| Gmail concern | Primitive reused |
|---|---|
| Account connect / token / refresh | `auth` (OAuth, central secrets, `getTokenFromCentral`) + the gmail integration |
| Background sync, retries, backoff | `infra/jobs` (`defineJob`), `infra/events`, `packages/{retry,inflight,semaphore}` |
| Live inbox updates (no polling) | `primitives/live-state` (`useResource`) + `database/change-feed` |
| Thread list (sort/filter/search/views) | `primitives/data-view` (+ `view-core`, `list`/`table` views) |
| Windowed long lists | `primitives/virtual-rows` |
| Full-text search | `search/engine` (tsvector GIN) + `search/quick-find` |
| Attachments storage/serve | `infra/attachments` (`uploadAttachment`, polymorphic links) |
| Compose rich text + inline images | `primitives/text-editor` (Lexical) + `paste-images` |
| Draft autosave / version history | `primitives/editable-field` + `history/engine` |
| Remote images (privacy / SSRF) | `infra/asset-mirror` + `infra/safe-fetch` |
| Bulk select + bulk action bar | `primitives/multi-select` (`SelectionBar`) |
| Keyboard shortcuts (j/k/e/x/…) | `primitives/shortcuts` |
| Optimistic triage + rollback | `primitives/optimistic-mutation` |
| Label chips / filter chips | `primitives/filter-chips`, `css/badge`, `css/cluster` |
| Layout (list + reading pane) | `primitives/app-shell` + `layouts/{miller,full-pane}` + `pane` |
| App registration / rail / tabs | `apps-core`, `create-app` skill |
| Entity tables = wire schema | `infra/entities` (`defineEntity`) |
| Notifications (bell + push) | `shell/notifications` |
| Cron-style delta when no webhook | `infra/jobs` scheduled job (documented no-polling exception) |

The genuinely new code: **sync engine, data model, mail UI sections.** Everything else is composition.

---

## 4. Data model (sketch — finalized in the foundation task)

Drizzle tables via `infra/entities` so `table.$inferSelect` ≡ `z.infer<schema>` by construction:

- `mail_accounts` — connected Google account (email, name, avatar, signature, default flags)
- `mail_sync_state` — per-account `historyId` watermark + last full-sync timestamp
- `mail_threads` — thread envelope (subject, participants, snippet, last message ts, unread/star/important flags, label ids)
- `mail_messages` — per-message (threadId FK, from/to/cc/bcc, headers, text body, sanitized html body, internalDate, draft flag)
- `mail_labels` — system + user labels (name, color, parent for nesting, type)
- `mail_message_labels` — M:N message↔label
- `mail_attachments` — via `infra/attachments` link to messages (filename, mime, size, gmail attachmentId for lazy fetch)
- `mail_drafts` — compose drafts (threadId?, to/cc/bcc, subject, body, attachment refs)
- `mail_outbox` — pending mutations (send/modify/trash) for optimistic queue + reconcile

**Threads vs messages:** the list is threads; the reading pane is the messages within a thread.

---

## 5. Sync strategy (the hard part)

- **Initial backfill:** paginated `messages.list` → batched `messages.get`; parse MIME (multipart, text+html alternatives, inline cid: images, attachments); store envelopes + bodies. Batched + rate-limited via `semaphore`/`inflight`/`retry` to respect per-user quota.
- **Incremental delta:** `history.list` from the stored `historyId` — Gmail's native delta API. Apply add/remove/label changes. Advance the watermark atomically.
- **History expiry fallback:** when Gmail rejects an old `historyId`, fall back to a bounded full resync.
- **No public webhook:** Gmail push (`users.watch` → Pub/Sub) needs an inbound public URL, which a worktree backend lacks. So the delta runs as a **scheduled `defineJob`**, not a timer — this is the documented escape hatch to the no-polling rule (upstream has no reachable change signal). Record *why* in the plugin CLAUDE.md.
- **Outbound:** every triage/compose action writes the local optimistic state immediately and enqueues a `mail_outbox` row; a job drains it against the Gmail API and reconciles (rollback on reject) via `optimistic-mutation`.

---

## 6. Feature breakdown

**Reading / triage:** thread list (snippet, sender, date, unread bolding, star/attachment/important indicators), reading pane (split or full, collapsed quoted history), mark read/unread, star, archive, trash, spam, snooze, bulk select + bulk actions, full Gmail keyboard shortcuts.

**Organization:** labels (create/edit/color/nest, apply/remove, sidebar), system views (Inbox/Starred/Snoozed/Sent/Drafts/Spam/Trash/All Mail/Important), optional category tabs, filters/rules engine (criteria → actions, mapped to `events`+`jobs`).

**Composition:** new/reply/reply-all/forward, rich text + inline images + attachments + drag-drop, draft autosave, recipient autocomplete, CC/BCC, signatures, scheduled send, send+archive, undo-send.

**Search:** full-text over indexed messages, Gmail operators (`from:`, `to:`, `subject:`, `has:attachment`, `label:`, `before:/after:`, `is:unread`), quick-find dialog.

**Settings:** signatures, vacation responder, display density, reading-pane position, notification prefs, label & filter management.

**Cross-cutting:** privacy-safe HTML rendering (sanitize; remote images proxied through `asset-mirror` and gated until "display images"), notifications (bell + push), UI Mastery polish pass.

---

## 7. Phased roadmap → task chain

Each phase is a shippable, testable increment, filed as one design-and-implement task in a linear chain (each picks up from the prior outcome):

0. **(this doc)** vision / north-star
1. **App scaffold + Gmail data model** — `create-app` mail app, tables, token wiring to the gmail integration
2. **Sync engine** — backfill + `history.list` incremental delta + watermark + MIME parsing
3. **Read-only inbox** — thread list (`data-view` + `virtual-rows`) on a `live-state` resource, reading pane (sanitize + remote-image gating), system views + label sidebar
4. **Triage actions** — read/star/archive/trash/spam/label, bulk select, keyboard shortcuts, optimistic mutations + outbox queue
5. **Compose / reply / forward / drafts** — Lexical editor, attachments, autosave, recipient autocomplete, signatures
6. **Search** — engine indexing + Gmail operators + quick-find
7. **Labels & filters** — label CRUD/nesting/color, filters/rules engine
8. **Advanced send & multi-account** — snooze, scheduled send, undo-send, vacation responder, multi-account
9. **Notifications & UI polish** — bell/push notifications, density modes, UI Mastery pass

---

## 8. Key decisions / risks to resolve per task

- **No-polling exception** must be explicit and documented (scheduled delta job; no reachable webhook).
- **HTML email is hostile** — aggressive sanitize; never leak tracking pixels before user opts into remote images.
- **Optimistic everywhere** — Gmail round-trips are slow; triage must feel instant with reliable rollback.
- **Quota / batching** — backfill must batch and back off; treat the per-user rate limit as a first-class constraint.
- **Threads vs messages** modeled distinctly from day one.
- **App vs integration boundary** — the app consumes the integration's capability signal; it never re-implements auth.
