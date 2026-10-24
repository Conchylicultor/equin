# Foreign-table handle pattern: closing the schema leak in `defineLink` / `defineExtension`

## Context

Two infra primitives — `attachments.defineLink` and `entity-extensions.defineExtension` — share a factory shape that *takes a foreign owner table and creates a side-table coupled to it*. Both factories return the raw drizzle `pgTable` to the consumer. Consumers then re-export the table from their plugin barrels and pass it back into free helper functions (`syncOwnerAttachments`, `upsertExtension`, `getExtension`).

This makes the side-table's schema part of the cross-plugin contract. It is the wrong contract — the side-table is internal to the subsystem (attachments / entity-extensions), not domain data the consumer should own. Today this manifests as one active leak (attachments) and one latent one (entity-extensions, copied verbatim from the attachments shape).

The fix is structural: factories that bind to a foreign owner must return a typed API handle that closes over the table, never the table itself. Once the table is no longer in any barrel, the existing plugin-boundary checker enforces the boundary mechanically — the violation becomes physically impossible.

## The active leak: attachments

### Pattern in use today

```ts
// plugins/tasks-core/server/internal/schema-attachments.ts
export const _taskAttachments = Attachments.defineLink(_tasks);
export const _conversationAttachments = Attachments.defineLink(_conversations);

// re-exported from plugins/tasks-core/server/index.ts
```

```ts
// plugins/conversations/server/internal/handle-post-turn.ts
import { syncOwnerAttachments } from "@plugins/infra/plugins/attachments/server";
import { _conversationAttachments } from "@plugins/tasks-core/server";

const existing = await db
  .select({ attachmentId: _conversationAttachments.attachmentId })
  .from(_conversationAttachments)
  .where(eq(_conversationAttachments.ownerId, id));
const merged = new Set([...existing.map(r => r.attachmentId), ...attachmentIds]);
await syncOwnerAttachments(_conversationAttachments, id, [...merged]);
```

The `conversations` plugin imports a raw `pgTable` from `tasks-core`'s barrel, runs ad-hoc drizzle queries against it, and hands it back to the attachments helper. The link table — which is purely internal infrastructure of the attachments subsystem (orphan sweep + FK cascade) — has become a public contract spanning three plugins.

### All current call sites

| File | Operation today | Intent |
|---|---|---|
| `plugins/tasks/server/internal/handle-create.ts` | `syncOwnerAttachments(_taskAttachments, row.id, body.attachmentIds)` | replace |
| `plugins/tasks/server/internal/handle-update.ts` | `syncOwnerAttachments(_taskAttachments, id, ids)` | replace |
| `plugins/tasks/server/internal/handle-create-chain.ts` | `db.insert(_taskAttachments).values(...).onConflictDoNothing()` | additive |
| `plugins/tasks/server/internal/handle-task-attachments.ts` | `db.select(...).from(_taskAttachments).innerJoin(_attachments, ...)` | list |
| `plugins/conversations/server/internal/handle-post-turn.ts` | read existing + union + `syncOwnerAttachments(_conversationAttachments, ...)` | additive (worked around) |
| `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/server/internal/handle-create.ts` | `syncOwnerAttachments(_launchPromptAttachments, id, ids)` | replace |
| `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/server/internal/handle-update.ts` | same | replace |
| `plugins/conversations/plugins/conversation-view/plugins/quick-prompts/server/internal/handle-create.ts` | `syncOwnerAttachments(_quickPromptAttachments, id, ids)` | replace |
| `plugins/conversations/plugins/conversation-view/plugins/quick-prompts/server/internal/handle-update.ts` | same | replace |
| `plugins/agents/server/internal/handle-update.ts` | `syncOwnerAttachments(_agentAttachments, id, ids)` | replace |

Three operations cover everything: **replace** (canonical mirror of a text field), **additive** (append-only union, no removals), **list** (join to `_attachments` for a given owner).

### A concrete bug the leak enabled

`handle-post-turn.ts` reads the existing link set, unions with new ids, then calls `syncOwnerAttachments` with the union. This is read-merge-write: two concurrent turns on the same conversation can both read pre-state and overwrite each other, dropping links the other inserted. Not catastrophic (the orphan sweep has TTL grace), but real. The workaround exists because there is no first-class additive primitive — the leaked table forced consumers to assemble one from raw SQL. A handle method `add(id, ids)` lowering to `INSERT … ON CONFLICT DO NOTHING` is atomic, one round trip, and removes the race.

## The latent twin: entity-extensions

`plugins/infra/plugins/entity-extensions/CLAUDE.md` opens with: *"Mirrors `attachments.defineLink` but for 1:1 side-tables."* It mirrored the API including the wart.

```ts
// plugins/agents/plugins/auto-launch/plugins/toggle/server/internal/tables.ts
export const _agentAutoLaunchExt = defineExtension(_agents, "auto_launch", {
  enabled: boolean("enabled").notNull().default(false),
});

// plugins/agents/plugins/auto-launch/plugins/toggle/server/internal/handle-set.ts
await upsertExtension(_agentAutoLaunchExt, agentId, { enabled: body.enabled });
```

Same three properties:
1. Factory returns the raw `pgTable` (`define-extension.ts:27` — `return pgTable(...)`).
2. Consumer barrel exports the table (`_agentAutoLaunchExt`).
3. Operations are free functions taking the table as the first argument.

The toggle plugin currently owns both the table definition and all its handlers, so nothing crosses a barrel *yet*. The leak is dormant — but the next consumer (a second extension on `_agents`, or any cross-plugin reader) reactivates it. The fix should land before the second consumer arrives.

## Design

### What good looks like at the call site

```ts
// In any consumer's tables.ts or schema-*.ts (drizzle-kit discovery file):
export const taskAttachments = Attachments.defineLink(_tasks);
export const agentAutoLaunch = EntityExtensions.defineExtension(_agents, "auto_launch", {
  enabled: boolean("enabled").notNull().default(false),
});

// Anywhere downstream:
await taskAttachments.set(taskId, ids);
await conversationAttachments.add(convId, ids);
const rows = await taskAttachments.list(taskId);

await agentAutoLaunch.upsert(agentId, { enabled: true });
const row = await agentAutoLaunch.get(agentId);
```

The pgTable never leaves the file it was defined in. Consumer barrels export only handles. Cross-plugin contracts are limited to the handle's typed methods.

### Proposed API

```ts
// attachments
interface AttachmentLink {
  set(ownerId: string, ids: readonly string[]): Promise<void>;
  add(ownerId: string, ids: readonly string[]): Promise<void>;
  list(ownerId: string): Promise<Attachment[]>;
}

// entity-extensions
interface EntityExtension<Cols> {
  get(parentId: string): Promise<Row<Cols> | undefined>;
  upsert(parentId: string, patch: Partial<Cols>): Promise<Row<Cols>>;
}
```

Both factories continue to be called from a `tables*.ts` / `schema*.ts` file matching the drizzle config glob (`server/drizzle.config.ts:24-29`). The `pgTable(...)` side-effect still runs at module-load time; drizzle-kit discovery is unaffected. The orphan sweep continues to use `getRegisteredLinks()` internally (`plugins/infra/plugins/attachments/server/internal/orphan-sweep.ts`); it never depended on consumer barrels.

### Why `set` and `add` are both first-class

They are different intents that lower to different SQL, not parameter variants of one operation:

- `set` — source of truth (a markdown column) is replaceable; the link set must mirror it. May shrink. Lowers to `INSERT ON CONFLICT DO NOTHING` followed by `DELETE WHERE NOT IN (...)`.
- `add` — source of truth grows append-only (turns in a conversation, rows in a chain). Lowers to `INSERT ON CONFLICT DO NOTHING`. One statement, atomic.

Trying to express `add` as `set(union(existing, new))` requires the round-trip race that today's `handle-post-turn` has. Two methods, two SQL plans, two intents — that is the right factoring.

`remove` is omitted: no caller needs it. Trivial to add when a real use appears.

### Where the line is

The handle is a **protocol object**, not a query DSL. The methods map 1:1 to operations the subsystem's contract requires (orphan-sweep correctness, FK shape, atomicity guarantees). It does not let callers compose `.where(...).join(...).orderBy(...)`.

Future operations are added as **named methods on the handle**, not as escape hatches that re-expose the table:

- Need `count(ownerId)`? Add `count` to `AttachmentLink`.
- Need `since(date)`? Add a method.
- Need to filter across many owners for an analytics view? At that point, the analytics plugin can reach into attachments-internal with a documented exception — but **don't pre-build the escape hatch**, because it would silently become the new default.

### Alternatives considered

**A richer ORM (drizzle relations, Prisma-style cascade writes).** Improves read syntax (`db.query.tasks.findFirst({ with: { attachments: true } })`), but the boundary question is unchanged: writes still need a named operation, and that name lives in a barrel somewhere. Drizzle's `relations()` is read-only; Prisma's `{ connect, set, disconnect }` is the same `{add, set, remove}` factoring expressed as JSON arguments. None of these answers "who owns the contract for participating in this subsystem". A ~30-line factory does.

**A sync engine (Zero, ElectricSQL, Replicache, …).** Would push you toward named mutators — structurally what `defineLink` returns — but demands global schema visibility on the client, which is the opposite of plugin encapsulation. Also irrelevant for this codebase's needs (reactive subscriptions are already solved by the `live-state` resource primitive). Adopting one to address a 30-line wrapper problem is buying capability we do not need and paying with coupling we do not want.

**Are we recreating SQL?** No. A DSL composes queries. This is a fixed-shape protocol with three (or two) named methods that lower to specific SQL. We are not adding a wrapper — `syncOwnerAttachments` already wraps SQL today. We are tightening that wrapper by binding the table to it at definition time and adding the missing `add` primitive.

## Implementation plan

### 1. Update `attachments.defineLink`

Files:
- `plugins/infra/plugins/attachments/server/internal/define-link.ts` — keep `pgTable` creation and `linkSources.push(...)` registration, but wrap them. Return a frozen `AttachmentLink` object whose methods close over the table.
- `plugins/infra/plugins/attachments/server/internal/sync-owner-attachments.ts` — fold into the handle as `set`. Add an `add` method (atomic insert). Add a `list` method (join to `_attachments`).
- `plugins/infra/plugins/attachments/server/internal/attachments.ts` — `Attachments.defineLink` returns `AttachmentLink`.
- `plugins/infra/plugins/attachments/server/index.ts` — drop the standalone `syncOwnerAttachments` export. Export `AttachmentLink` type.

### 2. Update `entity-extensions.defineExtension`

Files:
- `plugins/infra/plugins/entity-extensions/server/internal/define-extension.ts` — return a frozen `EntityExtension<Cols>` handle. Move `getExtension` / `upsertExtension` logic into handle methods.
- `plugins/infra/plugins/entity-extensions/server/internal/entity-extensions.ts` — `EntityExtensions.defineExtension` returns the handle.
- `plugins/infra/plugins/entity-extensions/server/index.ts` — drop standalone `getExtension` / `upsertExtension` exports. Export `EntityExtension` type.

### 3. Migrate consumers — attachments

For each `_xxxAttachments` table, rename to camelCase (`xxxAttachments`) and update the call sites. Drop re-exports of the `_xxx` table from consumer barrels.

- `plugins/tasks-core/server/internal/schema-attachments.ts` — `taskAttachments`, `conversationAttachments` (both as handles).
- `plugins/tasks-core/server/index.ts` — re-export the handles, drop the `_taskAttachments` / `_conversationAttachments` exports.
- `plugins/agents/server/internal/tables-attachments.ts` — `agentAttachments` handle.
- `plugins/agents/server/index.ts` — re-export the handle.
- `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/server/internal/tables-attachments.ts` — `launchPromptAttachments` handle.
- `plugins/conversations/plugins/conversation-view/plugins/quick-prompts/server/internal/tables-attachments.ts` — `quickPromptAttachments` handle.

Call-site updates:
- `plugins/tasks/server/internal/handle-create.ts:48` → `taskAttachments.set(row.id, body.attachmentIds)`
- `plugins/tasks/server/internal/handle-update.ts:36` → `taskAttachments.set(id, ids)`
- `plugins/tasks/server/internal/handle-create-chain.ts:104-109` → `taskAttachments.add(newTask.id, attachments.map(a => a.id))`
- `plugins/tasks/server/internal/handle-task-attachments.ts` → `return Response.json(await taskAttachments.list(taskId))` (delete the manual join + dto-mapping; the handle returns the same shape)
- `plugins/conversations/server/internal/handle-post-turn.ts:35-52` → collapses to `if (attachmentIds.length > 0) await conversationAttachments.add(id, attachmentIds);` — read+merge gone, race gone
- `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/server/internal/handle-create.ts:36-40` → `launchPromptAttachments.set(id, extractAttachmentIds(body.prompt))`
- `plugins/conversations/plugins/conversation-view/plugins/launch-prompts/server/internal/handle-update.ts:43-49` → `launchPromptAttachments.set(id, extractAttachmentIds(body.prompt))`
- `plugins/conversations/plugins/conversation-view/plugins/quick-prompts/server/internal/handle-create.ts` → `quickPromptAttachments.set(id, extractAttachmentIds(body.prompt))`
- `plugins/conversations/plugins/conversation-view/plugins/quick-prompts/server/internal/handle-update.ts` → same
- `plugins/agents/server/internal/handle-update.ts:81` → `agentAttachments.set(id, Array.from(ids))`

### 4. Migrate consumers — entity-extensions

- `plugins/agents/plugins/auto-launch/plugins/toggle/server/internal/tables.ts` — rename `_agentAutoLaunchExt` → `agentAutoLaunch`.
- `plugins/agents/plugins/auto-launch/plugins/toggle/server/index.ts` — export `agentAutoLaunch`, drop `_agentAutoLaunchExt`.
- `plugins/agents/plugins/auto-launch/plugins/toggle/server/internal/handle-set.ts:15` → `agentAutoLaunch.upsert(agentId, { enabled: body.enabled })`.
- Any reads via `getExtension(_agentAutoLaunchExt, ...)` → `agentAutoLaunch.get(...)` (currently none in the codebase, but the resource hook may use one — verify during execution).

### 5. Doc + check updates

- `plugins/infra/plugins/attachments/CLAUDE.md` — document the `AttachmentLink` API (set/add/list); explain the protocol-vs-DSL distinction in one paragraph.
- `plugins/infra/plugins/entity-extensions/CLAUDE.md` — same for `EntityExtension`. Update the "Mirrors `attachments.defineLink`" line to "Mirrors `attachments.defineLink` — both return a typed handle; the underlying pgTable never crosses the consumer's barrel."
- The plugin-boundary checker already refuses imports of non-barrel paths, and once the `_xxx` tables are no longer in any barrel, it mechanically forbids cross-plugin imports of them. No new lint rule needed.

## Verification

1. `./equin build` — the auto-generated migrations should be unchanged (the underlying tables are the same; only the TS API changed). Drizzle-kit discovery still picks the tables up via the `tables*.ts` glob.
2. `./equin check` — runs the plugin-boundary checker; should still pass and now mechanically prevents the leak.
3. Smoke test the affected flows in the UI:
   - Paste an image into a task description → save → reopen → image still rendered (set path).
   - Send a turn in a conversation with a pasted image → next turn with another image → both link rows present (`add` path, race-free).
   - Create a task via the chain form (improve / new-child-task) with attachments → attachments listed in the detail pane (`add` + `list`).
   - Toggle agent auto-launch on and off → state survives reload (`upsert` + `get`).
4. Manually grep that `_taskAttachments`, `_conversationAttachments`, `_agentAttachments`, `_launchPromptAttachments`, `_quickPromptAttachments`, `_agentAutoLaunchExt`, `syncOwnerAttachments`, `getExtension`, `upsertExtension` no longer appear outside their owning plugins' `internal/` directories. Empty result = leak closed.

## Out of scope

- Renaming or restructuring the orphan-sweep registry (`linkSources` / `getRegisteredLinks`). It is an internal implementation detail of attachments, already correctly hidden.
- Migrations: the underlying tables are unchanged. No SQL migration is generated; drizzle-kit only sees a schema diff if columns or constraints change, which they do not.
- Changing how attachments are uploaded or served on the wire. The `POST /api/attachments` endpoint and markdown reference format (`![](/api/attachments/<id>)`) are unchanged.
