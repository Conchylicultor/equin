# attachments

Polymorphic file attachments on disk, owned by per-consumer link tables. Each consumer plugin declares ownership with `Attachments.defineLink(ownerTable, linkRef)` and contributes its link set as `Attachments.Link`; the orphan sweep reclaims unreferenced rows past a TTL.

## Bytes are the host's: `AttachmentBlobs`

The rows (`attachments`, the owner links, the holds) and every route are
portable `server/` code; the BYTES go through the `AttachmentBlobs` host service
(`server/internal/blobs.ts`: `write(id, filename, bytes)` → the key the row
records as `disk_path`, `read(key)` → a `Blob` or `null` (the serve route's
410), `delete(key)` best-effort, `ensureRoot()`). The desktop's provider is
`attachments#machine` (UUID-named files in the host-global `state/attachments`
data dir); a host without a filesystem boots `plugins/memory-blobs`.

## API

An owner declares its link entity and link collection in its own `core/`
(`tasks-core/core/attachment-links.ts` is the reference):

```ts
// core/ — the `<owner table>_attachments` entity, and one owner's links as a
// scoped set by `ownerId` over the table's composite key
export const taskAttachmentLinksEntityRef = entityRef("tasks_attachments", attachmentLinkFields);
export const taskAttachmentLinks = liveCollection("tasks.attachment-links", {
  from: taskAttachmentLinksEntityRef,
  carry: { pick: ["ownerId", "attachmentId", "createdAt"] },
  baseExposures: false,
  id: compositeKey(["ownerId", "attachmentId"]),
  all: { by: ["ownerId"], orderBy: [["createdAt", "asc"]], max: ATTACHMENT_LINKS_MAX },
});
```

```ts
// server/internal/schema-attachments.ts (in the drizzle-kit schema glob)
export const taskAttachments = Attachments.defineLink(_tasks, taskAttachmentLinksEntityRef);
// Re-export the underlying table so drizzle-kit's schema glob picks it up.
// The leading `_` and the `internal/` location keep cross-plugin imports
// impossible — only `taskAttachments` (the handle) goes in barrels.
export const _taskAttachmentsTable = taskAttachments.table;

// server/internal/attachment-links.ts — spread into the plugin's contributions
const served = serveCollection(taskAttachmentLinks, { from: taskAttachments.table });
export const attachmentLinkContributions = [
  ...served.declare,
  Attachments.Link({ link: taskAttachments, served }),
];
```

`defineLink` builds the table with `defineEntity` (pk `(ownerId, attachmentId)`, both FKs cascading on delete and update) and refuses a ref not named `<owner table>_attachments`. A by-owner read of an owner that `defineLink` registered but never contributed fails loudly (`loader-failed`, reported).

```ts
await taskAttachments.set(taskId, ids);   // mirror canonical source (replaces)
await taskAttachments.setMany(entries);   // the same, for many owners at once
await taskAttachments.add(taskId, ids);   // append-only union (race-free, atomic)
```

The browser reads an attachment's bytes live too — `useLive(attachmentBytes, { id })` (core): a `bytes: true` value, served `immutable` (an upload always mints a new id), refused `missing` when the row or its bytes are gone — for a reader that decodes the file itself (a Sonata song's MIDI / MusicXML). An `<img>` / link still loads `GET /api/attachments/:id` as an asset (`assetPath(getAttachmentFile, …)`).

The browser reads one owner's attachments live: `useLive(attachmentsByOwner, { ownerType: "tasks", id })` (core), in link order. The value names no owner: its `follows` are built at `bindDeferredResources` (`followsAtBind`) from the `Attachments.Link` contributions — one follow per owner type's link set (`null` for every other type), then `attachments.rows` by the ids that set names (`follow.from`). So a link written for another owner, or another attachment's row, reaches no reader; an owner type no plugin contributed is refused `unknown-owner-type`.

`set` reconciles the link set to exactly match `ids` — used when the source of truth is replaceable (e.g. a markdown column). `add` is the atomic append-only union, used when the source grows monotonically (turns in a conversation). They lower to different SQL plans and are not parameter variants of each other.

### Many owners: `setMany`, never a `set` loop

`setMany([{ ownerId, ids }, …])` reconciles a whole document's owners at once (every block on a page); `set` is its one-entry case, so there is one implementation.

What matters is that it is **silent when nothing changed**: the diff key is the `(ownerId, attachmentId)` pair — the link table's PK — diffed in memory from ONE indexed read, so an unchanged set issues zero write statements. A `set` loop is a transaction per owner, and an unchanged owner still pays a delete-nothing DELETE, which a STATEMENT-level change-feed trigger cannot tell apart from a real write. Same reason it is a diff and not delete-all-then-reinsert: that rewrites unchanged rows.

`applyLinkDiff` (the transaction body) is db-parametrized so `define-link.test.ts` counts the statements each reconcile issues against a real Postgres.

## Holds: references the server cannot see

An upload is linked to its owner only when the owner is saved (a turn sent, a task created), and the sweep reclaims unlinked uploads after an hour. An unsent draft lives in browser storage, so it keeps its attachments alive with a **hold** instead: `holdAttachments(holder, ids, ttlMs)` (web, `PUT /api/attachments/holds`) replaces the holder's held set, expiring `ttlMs` from now (`null`: never); an empty set releases it. The sweep skips an attachment with a live hold and deletes expired holds.

Drafts never call it themselves: `primitives/text-editor/paste-images` observes every persistent-draft write (`onDraftWritten`) and re-asserts the attachments that draft references, for the draft's own TTL — so any `useDraft` holding markdown keeps its pasted images exactly as long as the draft lives.

## Protocol vs DSL

The handle is a **protocol object**, not a query DSL. Methods map 1:1 to operations the subsystem's contract requires (orphan-sweep correctness, FK shape, atomicity). It does not let callers compose `.where(...).join(...).orderBy(...)`. Future operations are added as named methods on the handle, never as escape hatches that re-expose the table.

The handle does expose `.table` — but only as a same-plugin escape for live-state resource loaders or other niche selects. The plugin-boundary checker (R4) prevents any cross-plugin import of the table because the table never leaves `internal/`; only the handle is barrel-exported.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Polymorphic file attachments. Exposes uploadAttachment() helper; storage/serve on the server plugin. Attachments: rows plus bytes in the host's blob store (AttachmentBlobs — on the desktop UUID-named files under ~/.equin/state/attachments/). Consumers declare ownership with Attachments.defineLink(ownerTable, linkRef) over a link entity their own core declares, serve its scoped link collection and contribute it as Attachments.Link — attachments.by-owner follows each contributed set (built at bind), naming no owner; orphan sweep reclaims unreferenced rows past TTL. holdAttachments keeps an attachment an unsent draft references alive for the draft's lifetime.
- Load-bearing: yes
- Server:
  - Contributes:
    - `resource.declare` "attachments.by-owner"
    - `resource.declare` "attachments.bytes"
    - `resource.declare` "attachments.file"
    - `resource.declare` "attachments.rows:rows"
    - `host-service:attachments.blobs` "attachments.blobs"
  - Uses:
    - `database.db`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `infra/endpoints.rawEndpointHandler`
    - `infra/entities.defaultNow`
    - `infra/entities.defineEntity`
    - `infra/jobs.defineJob`
    - `network/live.FollowBuilder`
    - `network/live.serveCollection`
    - `network/live.serveValue`
    - `primitives/log-channels.Log`
  - DB schema: `plugins/infra/plugins/attachments/server/internal/tables.ts`
  - Exports (types):
    - `AttachmentBlobsImpl`
    - `AttachmentLink`
    - `AttachmentLinkContribution`
  - Exports (values):
    - `_attachments`
    - `AttachmentBlobs`
    - `AttachmentMissingError`
    - `Attachments`
    - `createAttachment`
    - `deleteAttachment`
    - `getAttachment`
    - `readAttachmentBytes`
  - Register: `defineJob('attachments.orphan-sweep')`
  - Resources:
    - `attachments.by-owner` (push, whole: one owner's attachments — the files a person attached to one task or block, a handful, never a growing log)
    - `attachments.bytes` (invalidate, immutable)
    - `attachments.file` (push)
    - `attachments.rows:rows` (keyed, point)
  - Routes:
    - `POST /api/attachments`
    - `GET /api/attachments/:id`
    - `DELETE /api/attachments/:id`
    - `PUT /api/attachments/holds`
- Core:
  - Uses:
    - `fields/date/config.dateField`
    - `fields/int/config.intField`
    - `fields/text/config.textField`
    - `infra/endpoints.blob`
    - `infra/endpoints.dateString`
    - `infra/endpoints.defineEndpoint`
    - `infra/entities.entityRef`
    - `network/live.liveCollection`
    - `network/live.liveValue`
    - `packages/list-bound.wholeList`
  - Exports (types):
    - `Attachment`
    - `AttachmentFile`
    - `AttachmentLinkRow`
  - Exports (values):
    - `ATTACHMENT_LINKS_MAX`
    - `attachmentBytes`
    - `attachmentFields`
    - `attachmentFile`
    - `AttachmentFileSchema`
    - `attachmentLinkFields`
    - `attachmentRows`
    - `attachmentsByOwner`
    - `AttachmentSchema`
    - `attachmentsEntityRef`
    - `getAttachmentFile`
- Cross-plugin:
  - Imported by:
    - `apps/mail/attachments`
    - `apps/mail/mail-core`
    - `apps/pages/page-tree`
    - `apps/sonata/library`
    - `apps/sonata/sources/midi`
    - `apps/sonata/sources/musicxml`
    - `apps/sonata/transcription`
    - `conversations`
    - `conversations/agents`
    - `debug/read-set`
    - `infra/attachments/memory-blobs`
    - `page/attachment-block`
    - `page/audio`
    - `page/file`
    - `page/image`
    - `page/video`
    - `primitives/text-editor/paste-images`
    - `screenshot/draw-on-app`
    - `tasks`
    - `tasks/tasks-core`
- Exemptions:
  - Exempts itself from:
    - `no-db-backed-notify` — `server/internal/bytes.ts` (sanctioned)
    - `paths:no-hardcoded-paths` — `server/index.ts` (sanctioned)
    - `ids:pk-declared` — `server/internal/tables.ts` (debt)
- Web:
  - Exports (types): `UploadedAttachment`
  - Exports (values):
    - `holdAttachments`
    - `uploadAttachment`
- Sub-plugins:
  - **`memory-blobs`** (excluded) — Attachment bytes in memory: provides the AttachmentBlobs host service for a host without a filesystem (the browser composition, the portable boot test), the bytes lost with the process. Never booted…

<!-- AUTOGENERATED:END -->
