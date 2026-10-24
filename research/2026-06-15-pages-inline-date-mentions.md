# Inline `@` date mentions + reminders in the Pages editor

## Context

The Pages block editor supports Notion-style `[[page]]` inline links (type `[[`, pick a
page, get a clickable chip stored as a `[[<pageId>]]` token). There is **no** `@`-mention
typeahead for **dates**, and no way to attach a **reminder** to a page. This plan adds an
`@`-mention typeahead that:

- parses natural language (`@tomorrow`, `@next friday 3pm`, `@jun 20`) into a concrete date,
- inserts an inline **date chip** (relative-time display),
- optionally schedules a **reminder** that fires a bell notification at that time, linking
  back to the page.

Scope is **dates + reminders only** — there is no first-class "people" entity in this app,
so `@` is exclusively a date/reminder trigger.

The feature mirrors the existing `inline-page-link` plugin almost beat-for-beat, and reuses
the existing reminder pipeline primitives (`defineJob` + `enqueue({ runAt })` +
`recordNotification`). The one genuinely new dependency is **`chrono-node`** for NL date
parsing (no date library exists in the repo today).

## Design overview

A single new plugin `plugins/page/plugins/inline-date/`, structured exactly like
`plugins/page/plugins/inline-page-link/` (core + web + server in one plugin — mirroring that
precedent rather than over-splitting). Two token kinds in block `data.text`:

| Kind | Token | Meaning |
|---|---|---|
| Date | `[[date:<iso>]]` | Visual reference chip, no scheduling |
| Reminder | `[[reminder:<id>:<iso>]]` | Date chip **+** a scheduled notification (`<id>` is a stable UUID) |

`<iso>` is a frozen UTC instant resolved by `chrono-node` at insertion time (so `@tomorrow`
becomes a concrete date, Notion-style). The chip renders the date directly from the token —
no fetch needed for display.

Reminders are reconciled **server-side** from block text on every `page.blocksChanged` emit
(the same seam `page/links` uses to reindex backlinks). The block text is the source of
truth; a `page_reminders` table tracks scheduling state and is what the fire job consults.

### Why text-driven reconciliation (not imperative scheduling on click)

The chip can be copy/pasted, deleted, or the whole block removed. Driving the schedule from
"what reminder tokens currently exist in the page" makes the reminder lifecycle a pure,
idempotent function of block text — identical to how `reindexPage` is diff-based and
idempotent. Deleting the chip ⇒ token gone ⇒ reminder canceled. No dangling imperative state.

## Files to create

### `core/` — token grammar (shared web + server, single source of truth)

`plugins/page/plugins/inline-date/core/tokens.ts` (+ `core/index.ts` barrel)

Mirror `inline-page-link/core/tokens.ts`:

```ts
export const DATE_TOKEN_PATTERN     = /\[\[date:([0-9TZ:.+-]+)\]\]/;
export const REMINDER_TOKEN_PATTERN = /\[\[reminder:([a-f0-9-]+):([0-9TZ:.+-]+)\]\]/;
export function dateToken(iso: string): string { return `[[date:${iso}]]`; }
export function reminderToken(id: string, iso: string): string { return `[[reminder:${id}:${iso}]]`; }
// Scan all reminder tokens in a block's text -> [{ id, iso }] (server reconciler).
export function scanReminderTokens(text: string): { id: string; iso: string }[] { ... }
```

The id-restricted patterns (like `block-\d+-[a-z0-9]+` in page-links) prevent hijacking
arbitrary `[[...]]` text the user types.

### `web/` — inline node + typeahead

- `web/components/date-mention-node.tsx` — `DateMentionNode extends DecoratorNode<ReactNode>`,
  modeled on `page-link-inline-node.tsx`:
  - `static getType() { return "date-mention"; }`, `isInline(): true`, `updateDOM(): false`
  - **`getTextContent()` returns `""`** (critical — keeps `[[date:...]]` / `[[reminder:...]]`
    tokens out of live text reads used by the `@`/`[[`/slash scanners)
  - holds `{ iso, reminderId?: string }`; `decorate()` → `<DateMentionView/>`
  - `$createDateMentionNode`, `$isDateMentionNode`, `$createReminderNode` helpers
- `web/components/date-mention-view.tsx` — the chip. Reuses `LinkChip`
  (`@plugins/primitives/plugins/link-chip/web`) + `formatRelativeTime` / `<RelativeTime>`
  (`@plugins/primitives/plugins/relative-time/web`). Shows a calendar icon for dates, a bell
  icon for reminders. A hover/click affordance ("Remind me" ⇄ "Remove reminder") upgrades a
  date node to a reminder node (assigns a fresh `crypto.randomUUID()`) or downgrades it,
  re-serializing the token in place.
- `web/components/inline-date-plugin.tsx` — **the typeahead**, a near-copy of
  `inline-page-link-plugin.tsx` (`InlineDateMentionPlugin(props: BlockTextPluginProps)`):
  - `const TRIGGER = "@";` query terminates on newline (allow spaces, since "next friday"
    contains them — terminate on a second `@` or newline instead of whitespace)
  - same caret-rect portal, same `COMMAND_PRIORITY_CRITICAL` arrow/Enter/Esc/Blur handlers,
    same Esc-dismiss latch, same `insert*` routine (replace `@query`, insert node + trailing
    space, `space.select(1,1)`)
  - **option source**: a local `useDateOptions(query)` that runs `chrono.parse(query, refDate, { forwardDate: true })`. Renders up to two rows when the query resolves:
    1. `📅 <formatted date>` → inserts `$createDateMentionNode(iso)`
    2. `🔔 Remind me · <formatted date>` → inserts `$createReminderNode(crypto.randomUUID(), iso)`
    Plus fixed quick rows (`Today`, `Tomorrow`) when the query is empty. Show
    `<Loading variant="rows"/>` is unnecessary (parsing is synchronous); render a
    "Keep typing a date…" placeholder when nothing resolves.
  - **Time-of-day**: if chrono parsed no explicit time, default reminders to **09:00 local**
    before converting to UTC ISO. Plain date chips ignore time.
- `web/internal/register.ts` — side-effect, calls
  `registerBlockTextExtension(...)` **twice** (or once with a combined pattern): one extension
  for `DATE_TOKEN_PATTERN` → `$createDateMentionNode`, one for `REMINDER_TOKEN_PATTERN` →
  `$createReminderNode`, both `serializeNode` back to their tokens, the date one carrying
  `Plugin: InlineDateMentionPlugin`. (`registerBlockTextExtension` from
  `@plugins/page/plugins/editor/web`.)
- `web/index.ts` — plugin definition; `import "./internal/register"` as side-effect (no
  contributions array needed; the block editor discovers extensions via
  `getBlockTextExtensions()`).

### `server/` — reminder reconcile + fire (mirrors `page/links`)

- `server/internal/tables.ts` — `page_reminders` table:
  `id` (= the token's reminder UUID, PK), `pageId`, `blockId`, `fireAt` (timestamptz),
  `status` (`pending|fired|canceled`), `createdAt`. (DDL auto-migrated by `./equin build`.)
- `server/internal/reconcile.ts` — `reconcileReminders(pageId)`, diff-based & idempotent:
  1. load the page's blocks, `scanReminderTokens` across all `data.text`
  2. for each `{id, iso}` not yet `pending` with that `fireAt`: upsert row `pending` and
     `reminderFireJob.enqueue({ reminderId: id }, { runAt: new Date(iso) })`
  3. mark rows for this page whose `id` is no longer present → `canceled`
- `server/internal/reconcile-job.ts` — `reminderReconcileJob = defineJob({ name: "page.reminders.reconcile", event: z.object({ pageId: z.string() }), dedup: "none", run: ({event}) => reconcileReminders(event.pageId) })` — copy of `reindex-job.ts`.
- `server/internal/fire-job.ts` — `reminderFireJob = defineJob({ name: "page.reminders.fire", input: z.object({ reminderId: z.string() }), event: z.never(), dedup: { key: i => i.reminderId }, run })`. The handler **re-reads** the `page_reminders` row; **no-ops** unless `status === "pending"` (this is how cancellation works without removing the graphile job — an orphaned fire job for a deleted reminder simply finds `canceled`/missing and returns). On fire: `recordNotification({ type: "page.reminder", title: "Reminder", description: <block text snippet / page title>, variant: "info", linkTo: <pages route to pageId> })` then set row `fired`. Wrap the side effects in `ctx.step(...)`.
  - `dedup: { key: reminderId }` ⇒ graphile `job_key` dedup, so repeated reconciles don't pile
    up duplicate pending jobs, and a changed `fireAt` re-enqueue **replaces** the pending job.
- `server/index.ts` — `register: [reminderReconcileJob, reminderFireJob]`, contributions:
  `Trigger({ on: blocksChanged, do: reminderReconcileJob, with: {}, oneShot: false })`
  (imports `blocksChanged` from `@plugins/page/plugins/editor/server`, `Trigger` from
  `@plugins/infra/plugins/events/server`).

### `package.json`

Add `chrono-node` as a plugin-local dependency in `plugins/page/plugins/inline-date/package.json`.

## Key reused primitives (do not reinvent)

| Need | Reuse |
|---|---|
| Inline typeahead pattern | `plugins/page/plugins/inline-page-link/web/components/inline-page-link-plugin.tsx` |
| Inline decorator node shape | `plugins/page/plugins/inline-page-link/web/components/page-link-inline-node.tsx` |
| Register an inline token extension | `registerBlockTextExtension` (`@plugins/page/plugins/editor/web`) |
| Chip rendering | `LinkChip` (`primitives/link-chip/web`) |
| Date display | `formatRelativeTime` / `<RelativeTime>` (`primitives/relative-time/web`) |
| Reconcile-on-edit seam | `Trigger({ on: blocksChanged, ... })` — copy `page/links/server/index.ts` |
| Schedule a future fire | `defineJob` + `enqueue({ runAt })` (`infra/jobs/server`) |
| Surface the reminder | `recordNotification` (`shell/notifications/server`) |
| Menu portal/overlay | `Surface level="overlay"` (`primitives/surface/web`) |

## What this deliberately does NOT do

- No "people" mentions (no people entity).
- No NL parsing on the server — chrono runs only in the browser; the server only ever sees a
  resolved UTC ISO in the token.
- Does not touch the `active-data` system (that is keyed by conversationId/messageId and is
  for assistant transcript widgets, not editable page blocks).

## Verification

1. `./equin build` (regenerates the `page_reminders` migration, rebuilds, restarts).
2. Open a page at `http://att-1781558763-wnri.localhost:9000` (Pages app), in a text block
   type `@tomorrow` → confirm the typeahead shows a "📅 …" and "🔔 Remind me · …" row;
   pick the date row → inline date chip appears; reload the page → chip persists (token
   round-trips through `data.text`).
3. Type `@next friday 3pm`, pick "Remind me" → confirm a `page_reminders` row via MCP:
   `query_db("select id, page_id, fire_at, status from page_reminders order by created_at desc limit 5")`,
   and a scheduled job via `query_db` on `graphile_worker.jobs` (or the Debug → Queue pane).
4. **Reminder fires**: insert a reminder a minute out (`@in 1 minute`), wait, confirm the bell
   notification appears and `linkTo` navigates back to the page; the row flips to `fired`.
5. **Cancellation**: delete a pending reminder chip, save, then confirm via `query_db` the row
   is `canceled` and (at its original time) no notification fires.
6. Scripted check with `e2e/screenshot.mjs --click` to confirm the typeahead menu opens on `@`.
7. `./equin check` (boundaries, type-check, migrations-in-sync, plugins-doc-in-sync).

## Open questions / decisions taken as defaults

- **Reminder time default**: 09:00 local when no time is parsed. (Adjustable later via a time
  picker in the chip.)
- **Notification body**: page title + a short snippet of the reminder's block text.
- **Single plugin vs umbrella**: chose a single `inline-date` plugin (mirrors `inline-page-link`,
  which co-locates web typeahead + server extractor). If the reminder surface grows (recurring
  reminders, a reminders inbox view), split `reminders` into its own sub-plugin then.
