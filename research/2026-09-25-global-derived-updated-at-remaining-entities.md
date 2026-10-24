# Derived `updatedAt` for the remaining entities, and deleting `"app-managed"`

Follow-up to `research/2026-09-25-global-derived-updated-at.md` §5.

## Context

tasks, attempts and conversations now derive `updated_at` in the database. A
per-column `touchedBy` declaration is compiled into a BEFORE UPDATE trigger that
bumps `updated_at` only on a real change to a counted column, and RAISEs on any
app write to it. Every other `defineEntity` table with an `updatedAt` field
still opts out with `updatedAt: "app-managed"` and stamps the column by hand.
That causes spurious bumps on no-op writes and silent misses when a site
forgets.

The audit confirmed the whole remaining population:

- mail-core ×8
- events-core ×2
- sonata track-mixer ×1
- all 24 entity-extension side-tables, through the one hardcoded site in
  `define-extension.ts`

No other `defineEntity` table has `updatedAt`. Once all of them are classified
and every stamp is removed, the `"app-managed"` arm is deleted, so every entity
with `updatedAt` is derived.

**Classification rule.** A column counts (`true`) when changing it is a change
to the record that a reader could see. Engine bookkeeping never counts
(`false`): sync watermarks (`historyId`, `last*SyncAt`), sighting stamps
(`firstSeenAt` / `lastSeenAt`), hydration and probe markers, and retry
counters. Identity columns (`id`, FK owner, `createdAt`) are `false`.

**Readers that depend on it** (the only ones found):

- `events` revision tick: `events-core/server/internal/resources.ts:47`,
  `count + max(updated_at)`.
- `mail_threads` revision tick: `threads/server/internal/revision-resource.ts:19`.

Both must move on every list-visible change. Every list-visible column is
therefore `true`. Their "every write MUST set updatedAt" comments are rewritten
to "every counted column change moves it".

The rest of the `updatedAt` readers are only incidental: the timestamp rides
on the wire in push resources, so today's no-op bumps cost a push to the
client. After this change those pushes go away, which is an improvement.

## 1. mail-core (`mail/plugins/mail-core/server/internal/tables.ts`)

| table | `true` | `false` |
|---|---|---|
| `mail_accounts` | email, name, avatarUrl, signature, connectedAt | id, createdAt |
| `mail_sync_state` | status, errorCode, lastError | accountId, historyId, lastFullSyncAt, lastDeltaSyncAt, lastErrorAt, resyncCount, createdAt |
| `mail_labels` | name, type, color, textColor, parentId, messageListVisibility, labelListVisibility | id, accountId, createdAt |
| `mail_threads` | subject, snippet, participants, lastMessageAt, messageCount, unread, starred, important, hasAttachments, labelIds | id, accountId, historyId, createdAt |
| `mail_messages` | threadId, from, to, cc, bcc, replyTo, subject, snippet, headers, bodyText, bodyHtml, internalDate, unread, starred, isDraft, isSent, hasAttachments, sizeEstimate | id, accountId, bodyFetchedAt, historyId, createdAt |
| `mail_attachments` | gmailAttachmentId, filename, mimeType, sizeBytes, inline, contentId, storedAttachmentId | id, messageId, accountId, createdAt |
| `mail_drafts` | threadId, gmailDraftId, inReplyToMessageId, to, cc, bcc, subject, bodyHtml, bodyText | id, accountId, createdAt |
| `mail_outbox` | opType, targetType, targetId, payload, status, attempts, lastError | id, accountId, createdAt |

Stamps to delete are all in `mail/plugins/sync/server/internal/`, plus one in
attachments:

- `store.ts`:
  - `upsertLabels` `:57-71`, `excluded.*` set
  - message upsert `:176-182`
  - `markMessagesWithAttachments` `:272-282`
  - `recomputeThread` `:336-353`
- `bootstrap.ts:101-112`
- `backfill.ts:110-113, 134-145`
- `delta.ts:82-95, 102-113, 120-133`
- `record-error.ts:23-36, 53-74`
- `mail/plugins/attachments/server/internal/handlers.ts:58-61`

`mail_drafts` and `mail_outbox` have no writers yet, so their declarations are
forward-looking only.

**Side effect:** the per-minute delta tick, which re-upserts labels and
recomputes threads with identical values, stops moving `updated_at`. That also
stops the spurious thread-tick and labels pushes it causes today.

## 2. events-core (`events/plugins/events-core/server/internal/tables.ts`)

**`event_sources`**

- `true` (user config): name, config, refresh, enabled.
- `false`: id, type (immutable), createdAt, and the run bookkeeping: status,
  lastFingerprint, lastRunAt, nextRunAt, lastError, lastErrorCode, lastFlags,
  lastOutcome, lastEventCount.
- Nothing reads this table's `updatedAt`. The revision tick deliberately
  ignores it.

**`events`**

- `true`: sourceId, externalId, title, description, date, startsAt, endsAt,
  allDay, venue, city, url, imageUrl, price, category, tags, recurring,
  recurrenceLabel, disappearedAt.
- `false`: id, firstSeenAt, lastSeenAt, createdAt.
- `lastSeenAt` is not rendered anywhere. A content-identical re-extraction
  therefore no longer pulses open Events lists, and a real change still does.
  The reanchor job's `startsAt` roll-forward still bumps it, as it should,
  because that is visible.

Stamps to delete:

- `event-list` / `events-core` `events-repo.ts`:
  - `upsertEvents` `:97` (insert values) and `:100-108` (conflict set)
  - `markEventsDisappeared` `:150-166`
  - `reanchorRecurringEvents` `:267`
- `sources-repo.ts:115` (`updateSource`)
- `refresh/server/internal/run-ledger.ts:62, 127`

Rewrite the tick comment at `resources.ts:29-34`.

The run ledger's `eventsUpdated` count uses `xmax = 0`, not `updatedAt`, so it
is unaffected. Its "re-seen, not content-changed" meaning is out of scope.

## 3. sonata track-mixer

In `sonata_track_view`:

- `true`: color, instrument, muted, hidden, volume.
- `false`: songId, trackId, createdAt.

In `track-mixer/server/internal/routes.ts:18`, drop the `updatedAt: now` seed
of `set`. When the body carries no field, `set` would be empty and drizzle
rejects an empty `onConflictDoUpdate` set. Keep the no-op spelled as
`set: { trackId: sql\`excluded.track_id\` }`, i.e. rewriting the PK with its
own value. The trigger sees no change, so it neither bumps nor raises.

## 4. entity-extensions: default all-true, with overrides (decided)

In `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts`:

- **`ExtensionMeta`** gains an optional
  `touchedBy?: Partial<{ [K in keyof OwnFields<Sh>]: TouchRule<InferFieldValue<OwnFields<Sh>[K]>> }>`,
  typed per column the same way as `defineEntity`, so a mistyped transition is
  a tsc error.
- **`defineExtension`** builds the total map itself:
  - the key: `false`;
  - `createdAt`: `false`;
  - every own field: `meta.touchedBy?.[k] ?? true`.

  It passes `{ touchedBy }` instead of `"app-managed"`. A new column counts by
  default, so it cannot be missed. The only possible error is over-counting,
  which is harmless.
- **Presence-only extensions** such as `starred`, which has no own fields,
  compile a trigger that never bumps. That is correct, since nothing about the
  row can change.
- **`upsert()`** drops `updatedAt: now` from both `values` and the conflict
  `set`. An empty patch would leave `set` empty, so it becomes
  `{ [key]: id }`, a PK self-rewrite that is a no-op.
- **Overrides** (the only two):
  - `sonata/.../midi` `contentHash: false`: a backfilled derived hash, not a
    change to the song's MIDI.
  - `deploy/plugins/health` `checkedAt: false`: every probe moves it. A probe
    whose outcome is unchanged is not a change.
- **Direct writes that bypass `upsert()`**, with their stamps deleted:
  - `sonata/plugins/playback-history/server/internal/routes.ts:19`
  - `deploy/plugins/health/server/internal/handle-forget-host-key.ts:19-23`
  - `conversations-view/plugins/queue/server/internal/queue-ranks.ts:349-360`
    (both values and set) and `:373-383`
  - The two midi `import.ts` updates already write no stamp and need no change.
- **Docs:** update the entity-extensions CLAUDE.md with a short "updatedAt"
  paragraph (derived, default all-true, override via `meta.touchedBy`).

## 5. Delete the `"app-managed"` arm

**`entities/server/internal/types.ts:192-195`**

- `UpdatedAtMeta<F> = { readonly touchedBy: TouchedBy<F> }`.
- Drop the legacy comment.

**`define-entity.ts`**

- Remove the `decl === "app-managed"` branch (`:296`).
- Fix the error text at `:293` and the doc comment at `:271`.
- `derivedUpdatedAt` is now always present when the entity has `updatedAt`.
  If `Entity.derivedUpdatedAt`'s type can say so, tighten it; otherwise leave
  it optional.

**`derived-updated-at.test.ts`**

- Delete the `'"app-managed" compiles nothing'` test (`:95-100`).
- Switch the fixtures at `:121`, `:161` and `:175` to a `touchedBy` declaration
  or remove them.
- Add `@ts-expect-error` that `"app-managed"` is no longer accepted.

**Docs**

- `entities/CLAUDE.md`: in `:178` drop the opt-out, and rewrite `:192`, since
  extensions are no longer the exception.
- `derived-updated-at/CLAUDE.md`: no change.
- Original design doc: append one line to §5 pointing here.

**Final gate:** `rg '"app-managed"'` returns nothing outside `research/`.

## 6. Raw-`pgTable` tables (not in this change)

16 hand-written `timestamp("updated_at")` tables get no guarantee until they
move to `defineEntity`. Examples: conversations/agents, active-data,
conversation-category, reports, page editor, saved-themes, deploy servers and
deployments, view-order, custom-columns.

Each is its own migration: schema-stable, but every call site changes. After
the user approves, file one follow-up `add_task` that lists them, rather than
widening this change.

## Verification

1. **Tests:**
   `./equin test plugins/infra/plugins/entities plugins/infra/plugins/entity-extensions plugins/database/plugins/derived-updated-at plugins/apps/plugins/mail plugins/apps/plugins/events plugins/apps/plugins/sonata/plugins/track-mixer`.
   - Extend `define-extension.test.ts` so the compiled spec is all-true with
     key/createdAt `false`, and an override is honoured.
   - The upsert SQL no longer carries `updated_at`.
   - The empty patch compiles to a valid set.
2. **Deploy:** `./equin build` (background), then `./equin check`
   (type-check covers every `touchedBy` totality and the arm removal).
3. **Triggers:** `query_db` on the worktree DB. `pg_trigger` should have
   `*_derive_updated_at`, each with a signature comment, on:
   - the 8 mail tables;
   - `event_sources`, `events`, `sonata_track_view`;
   - every `*_ext_*` table.
4. **Behaviour, driven in the worktree app:**
   - Mail: let one delta tick run on an idle mailbox. `max(updated_at)` on
     `mail_threads` and `mail_labels` is unchanged, and starring a thread
     moves it.
   - Events: refresh a source whose content is unchanged. `events.updated_at`
     is unchanged, and `last_seen_at` moved.
   - Change a track's volume: `sonata_track_view.updated_at` moves.
     Re-sending the same volume leaves it unchanged.
   - Pin a queue group, star a page, and record a play: none of these raise.
     This covers the extension write paths.
5. **Boot:** check the worktree server log for any
   `updated_at is derived … do not write it` exception. That would name a
   stamp that was missed.

> Done for §6: see `2026-09-25-global-derived-updated-at-raw-tables.md` — raw
> tables declare via `deriveUpdatedAt`, and the `derived-updated-at:declared`
> check closes the set.
