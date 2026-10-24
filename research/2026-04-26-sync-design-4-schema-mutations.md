# Sync redesign 4 — schema, mutations, optimistic updates

> Companion sub-design to [`2026-04-26-sync-engine-issues.md`](./2026-04-26-sync-engine-issues.md). Targets issues **#4 (transactional consistency between writes and notifications), #5 (optimistic updates not a primitive), #10 (schema migrations are a separate fragile track), #11 (no write-time validation primitive)**. Out of scope: wire protocol, live-query engine, authorization model.

## 1. Problem restatement

Today, the Singularity sync layer treats schema, validation, transactional writes, and optimistic UI as **four separately-maintained tracks of glue code**. Drizzle owns table shape; an ad-hoc mix of `typeof body.x !== "string"` and per-plugin Zod owns request validation; mutation handlers do their own DB calls then hand-fire `someResource.notify()` post-commit (not in the txn); optimistic UI is a `useState` shadow that each plugin reinvents. The result is silent staleness when an author forgets a `notify`, half-applied state on mid-mutation crash, racy "snapshot N for resource A, snapshot N-1 for resource B" reads, and a janky UI that waits for a full HTTP→WS round trip on every click. The four tracks need to collapse into **one primitive** where defining a table also defines its validators, its mutations, its sync emissions, and its optimistic-update semantics — so a plugin author writes "what is a task and how do I create one" once, and the system derives the rest.

## 2. The four sub-problems

### (a) Schema as single source of truth
A schema declaration must be the only place that describes table shape, runtime validators (insert/update), TypeScript types (`Doc<T>`, `InsertInput<T>`), and migration intent. Today these live in: `tables.ts` (Drizzle), `shared/*.ts` (Zod request shapes), descriptor files (sync payload types), and the migration SQL on disk. Four declarations that drift.

### (b) Validation pipeline
Every write — from any HTTP handler, MCP tool, or internal job — must funnel through the same validator derived from (a). Today some routes use Zod, some `typeof`, some nothing; the DB-level `.notNull()` is the last line of defense and surfaces as a 500 instead of a 400.

### (c) Transactional write + sync emission
A mutation that touches N tables must (1) run inside one DB transaction, (2) collect the set of resources/queries impacted, and (3) emit those notifications **as part of the commit**, atomically — not fire-and-forget after `await db.commit()` returns. Subscribers should see resource A and resource B advance to the same logical version, never one-at-N and one-at-N-1.

### (d) Optimistic UI as a primitive
The same write description should produce: a *server-authoritative* execution path and a *client-side speculative* execution path that mutates the local cache before the round trip and rolls back on rejection. The author must never re-implement this. Components should `useTask(id)` and read whatever the local view currently is — speculative or confirmed — without knowing which.

How each surveyed system collapses these four into one:

| System | Pattern |
| --- | --- |
| Convex | Schema → validators → mutation function → automatic txn → automatic invalidation; `withOptimisticUpdate` writes to `localStore` and is rolled back on settle. One author surface. |
| Replicache / Zero | The mutator function *itself* is the source of truth: the same code runs client-side (speculative) and server-side (authoritative), validation lives inside the function body, and rebasing on pull replays unconfirmed mutations. |
| Triplit | `S.Schema` defines collection + validator + TS type; `client.transact` is atomic; sync is built-in; optimism is the default (writes go to the local store first). |
| TanStack DB | `createCollection({ onUpdate, onDelete, ... })` registers the server effect; `collection.update(id, draft)` mutates the optimistic overlay; rollback on handler throw. |
| Linear | Object-graph save → transaction queued in IndexedDB → applied locally → push to server with monotonic syncId → server-authoritative reconciliation via WS. |

## 3. Frameworks surveyed

### 3.1 Convex

**Schema.** A single `schema.ts` is the source of truth. The `v.*` validator builder produces both Drizzle-equivalent column types *and* the runtime validators used by mutations.

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    body: v.string(),
    user: v.id("users"),
  }),
  users: defineTable({
    name: v.string(),
    tokenIdentifier: v.string(),
  }).index("by_token", ["tokenIdentifier"]),
});
```

`npx convex dev` regenerates `Doc<"messages">` types and validates *all existing rows* against the schema before accepting the push. ([Convex schemas](https://docs.convex.dev/database/schemas))

**Validation.** The same `v.*` builder declares mutation arg types. Validation runs *before* the handler body, so the handler sees typed `args`:

```ts
// convex/tasks.ts
import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const createTask = mutation({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("tasks", { text: args.text });
  },
});
```
([Convex mutations](https://docs.convex.dev/functions/mutation-functions))

**Transactional writes.** Every mutation is automatically a transaction: "All database reads inside the transaction get a consistent view of the data… All database writes get committed together. If the mutation writes some data to the database, but later throws an error, no data is actually written." Subscribers are notified as part of commit — there is no explicit `notify()` call in user code.

**Optimistic UI.** `useMutation` returns a callable; `withOptimisticUpdate` patches the local store before the network round trip. The framework rolls it back automatically on settle.

```ts
const sendMessage = useMutation(api.messages.send).withOptimisticUpdate(
  (localStore, { channel, body }) => {
    const existing = localStore.getQuery(api.messages.list, { channel });
    if (existing === undefined) return;
    const newMessage = {
      _id: crypto.randomUUID() as Id<"messages">,
      _creationTime: Date.now(),
      channel, body,
    };
    localStore.setQuery(api.messages.list, { channel }, [...existing, newMessage]);
  },
);
```
([Convex optimistic updates](https://docs.convex.dev/client/react/optimistic-updates))

**Migrations.** No SQL migration files. You edit `schema.ts`; `convex deploy` validates existing data against it and rejects pushes that would break invariants. For data migrations (renames, backfills) the recommended pattern is a four-step dual-write: ship code writing both shapes, run an async `mutation` over each row, ship code reading the new shape, drop the old field. ([Convex migrations](https://stack.convex.dev/intro-to-migrations))

### 3.2 Replicache

**Schema.** Replicache is intentionally schema-light: storage is KV. The "schema" is the union of mutator signatures and the shape your mutators write.

**Mutators** are the unifying primitive — same function name on client and server, both use a `WriteTransaction`:

```ts
// shared mutator — runs both places
async function createTodo(tx: WriteTransaction, todo: Todo) {
  await tx.set(`/todo/${todo.id}`, todo);
}

// client
const rep = new Replicache({ mutators: { createTodo } });
await rep.mutate.createTodo({ id: "t1", text: "task" });
```

**Push/pull/rebase.** Pending client mutations are pushed; server runs the *server* implementation of the same mutator name in its own DB transaction and records `lastMutationID` per client. On pull, Replicache "rewinds the state of the Client View to the last version it got from the server, applies the patch, and then replays any pending mutations on top." This is automatic conflict resolution: an unconfirmed mutator re-runs against newer state. ([Replicache concepts](https://doc.replicache.dev/concepts/how-it-works))

**Optimistic UI.** Optimism is *not opt-in*. Calling `rep.mutate.x(...)` writes to the local store synchronously; subscribers see the new state immediately; rebase on pull silently replaces it with the server view.

### 3.3 Zero (Rocicorp, successor to Replicache)

Zero takes Replicache's mutator model but adds typed schema, ZQL queries, and *speculative server view*.

**Schema.**
```ts
const user = table('user').columns({
  id: string(), name: string(), partner: boolean(),
}).primaryKey('id');

export const schema = createSchema({ tables: [user], relationships: [] });
```
The schema drives ZQL type-safety, replication shape, and column validation. ([Zero schema](https://zero.rocicorp.dev/docs/zero-schema))

**Custom mutators.** A mutator is a function with a Zod (or any standard-schema) arg validator and a body that uses `tx.mutate` (CRUD) and `tx.run` (ZQL reads):

```ts
const updateIssue = defineMutator(
  z.object({ id: z.string(), title: z.string() }),
  async ({ tx, args: { id, title } }) => {
    const issue = await tx.run(zql.issue.where('id', id).one());
    if (issue?.status === 'closed') throw new Error('closed');
    if (title.length > 100) throw new Error('Title too long');
    await tx.mutate.issue.update({ id, title });
  },
);
```
([Zero mutators](https://zero.rocicorp.dev/docs/mutators))

**Transactions.** "Reads and writes within a mutator are transactional, meaning that the datastore is guaranteed to not change while your mutator is running. And if the mutator throws, the entire mutation is rolled back." ([Zero writing data](https://zero.rocicorp.dev/docs/writing-data))

**Speculative server view.** The client mutator runs against the local IVM cache for instant UI. The same mutator is sent to the `/push` endpoint, which executes server-side in a Postgres transaction (often via Drizzle) and writes a row to a `mutation_log` table. Logical replication carries the log entry to `zero-cache`, which broadcasts to all subscribed clients. "The server mutator always takes precedence over the client mutator. The result from the client mutator is considered speculative and is discarded as soon as the result from the server mutator is known." ([Zero notes by Sólberg](https://www.solberg.is/zero))

**Server-only side effects.** The same registry pattern lets you wrap a shared mutator with server-only behaviour (audit logs, email):

```ts
export const serverMutators = defineMutators(sharedMutators, {
  posts: {
    update: defineMutator(z.object({ id: z.string(), title: z.string().optional() }),
      async ({ tx, ctx, args }) => {
        await sharedMutators.posts.update.fn({ tx, ctx, args });
        await tx.mutate.auditLog.insert({ issueId: args.id, timestamp: Date.now() });
      }),
  },
});
```

**Awaiting either layer.**
```ts
const write = zero.mutate(mutators.issue.insert({ id, title: 'New' }));
await write.client; // local apply done
await write.server; // server confirmed
```

### 3.4 Triplit

**Schema.** A single `schema` const is shared by client and server; types and validators come from the same `S.*` builder.

```ts
import { Schema as S, ClientSchema } from '@triplit/client';

export const schema = {
  todos: {
    schema: S.Schema({
      id: S.Id(),
      text: S.String(),
      completed: S.Boolean({ default: false }),
    }),
  },
} satisfies ClientSchema;
```
([Triplit schemas](https://www.triplit.dev/docs/schemas))

**Mutations.** Single-row methods (`insert`, `update`, `delete`) and multi-row `client.transact()` for atomic groups. Updates use a draft-mutation callback (Immer-like):

```ts
client.update('todos', todo.id, (draft) => {
  draft.completed = !draft.completed;
});
```

**Sync.** Triplit sync is always-on; mutations are written to the local store first (optimistic by default) and propagated. Permission rules live in the schema definition. On reconnect, when client schema and server schema differ, the client refuses to sync until the developer ships a migration; an `onDatabaseInit` hook surfaces issues. ([Triplit schema updating](https://www.triplit.dev/docs/schemas/updating))

### 3.5 ElectricSQL + TanStack DB

ElectricSQL deliberately stops at *read* sync — it leaves writes to a higher layer. The blessed pairing for writes is **TanStack DB**, whose collections expose mutation handlers with built-in optimistic state.

```ts
const todoCollection = createCollection({
  id: 'todos',
  onUpdate: async ({ transaction }) => {
    const { original, changes } = transaction.mutations[0];
    await api.todos.update(original.id, changes);
  },
});

// Optimistic immediately:
todoCollection.update(todo.id, (draft) => { draft.completed = true });
```

The collection holds the optimistic overlay separately from synced data, so live queries see `synced + optimistic`; if `onUpdate` throws, the optimistic state is rolled back. For multi-step UX flows there's `createOptimisticAction` and `createTransaction`. ([TanStack DB overview](https://tanstack.com/db/latest/docs/overview))

ElectricSQL's own "write patterns" guide enumerates four levels — REST-only, `useOptimistic`, shared persistent optimistic store (Valtio + LocalStorage), and full through-the-database sync via PGlite + shadow tables + triggers. The fourth pattern is the most powerful: the client writes to a local Postgres, a trigger appends to a change log, the change log is shipped to the server, the server applies it, replication updates the immutable table, and the optimistic shadow is cleared. ([ElectricSQL writes](https://electric-sql.com/docs/guides/writes))

### 3.6 Linear

**Object-graph + transaction queue.** Models are defined with MobX decorators. `user.name = 'x'; user.save()` queues a *transaction* (the unit Linear pushes/pulls) into IndexedDB, optimistically applies it to the in-memory object pool, and ships it to the server.

**Server-ordered serialization.** The server assigns each accepted transaction a monotonically-incrementing `syncId`. Clients track their last seen `syncId`; on reconnect they ask "give me everything since N" and receive transactions to replay. This is closer to OT than CRDT — the server is the total-order arbiter. ([Linear sync engine, Fujimon](https://www.fujimon.com/blog/linear-sync-engine), [Scaling the Linear Sync Engine](https://linear.app/now/scaling-the-linear-sync-engine))

**Conflict resolution.** Last-write-wins for most fields (Linear notes that conflicts are rare given their UX). Rich-text fields use a CRDT.

### 3.7 Prisma vs Drizzle vs Atlas

**Prisma** keeps `schema.prisma` as the source of truth. `prisma migrate dev` diffs the schema against the shadow DB and writes timestamped SQL migrations; `prisma migrate deploy` applies them in CI. Hybrid: declarative authoring, imperative artefacts. ([Prisma Migrate](https://www.prisma.io/docs/orm/prisma-migrate))

**Drizzle** (current Singularity stack) — `drizzle-kit generate` mirrors the Prisma flow. `drizzle-zod` derives Zod validators from the same Drizzle table:

```ts
const users = pgTable('users', {
  id: integer().generatedAlwaysAsIdentity().primaryKey(),
  name: text().notNull(),
  age: integer().notNull(),
});
const userInsertSchema = createInsertSchema(users, {
  name: (s) => s.max(200),
});
```
([Drizzle Zod](https://orm.drizzle.team/docs/zod)) — this is the existing pathway to make today's schema *also* the validator source, without abandoning Drizzle.

**Atlas** is the most aggressive declarative tool: you declare the desired DB state (HCL or via your ORM) and `atlas migrate diff` generates versioned SQL artefacts that match. `atlas schema apply` can also apply directly. ([Atlas declarative vs versioned](https://atlasgo.io/concepts/declarative-vs-versioned))

### 3.8 TanStack Query / RTK Query

Lower-bar libraries. Both express optimism via *cache patches*:

```ts
// TanStack Query
useMutation({
  mutationFn: updateTodo,
  onMutate: async (newTodo, ctx) => {
    await ctx.client.cancelQueries({ queryKey: ['todos', newTodo.id] });
    const prev = ctx.client.getQueryData(['todos', newTodo.id]);
    ctx.client.setQueryData(['todos', newTodo.id], newTodo);
    return { prev };
  },
  onError: (_e, _v, _r, { prev }, ctx) =>
    ctx.client.setQueryData(['todos', newTodo.id], prev),
  onSettled: (t, _e, _v, _r, ctx) =>
    ctx.client.invalidateQueries({ queryKey: ['todos', t.id] }),
});
```
([TanStack Query optimistic updates](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates))

```ts
// RTK Query
updatePost: build.mutation({
  query: ({ id, ...patch }) => ({ url: `post/${id}`, method: 'PATCH', body: patch }),
  onQueryStarted({ id, ...patch }, { dispatch, queryFulfilled }) {
    const patchResult = dispatch(api.util.updateQueryData('getPost', id, draft => {
      Object.assign(draft, patch);
    }));
    queryFulfilled.catch(patchResult.undo);
  },
}),
```
([RTK Query manual cache updates](https://redux-toolkit.js.org/rtk-query/usage/manual-cache-updates))

These set the *floor*: any redesign should at least match this ergonomics, with the difference that the patch derives from the shared mutator instead of being a separate hand-written `setQueryData`.

### 3.9 Firestore

Writes are queued in IndexedDB while offline; the local listeners reflect them immediately (optimistic by default). `runTransaction` requires connectivity and rejects offline. Batched writes queue and execute opportunistically. Rollback on failure is automatic for writes that the server later rejects, surfaced as a snapshot of the corrected document. ([Firestore offline](https://firebase.google.com/docs/firestore/manage-data/enable-offline))

### 3.10 Effect Schema / Valibot / ArkType

Beyond Zod, these provide schema-as-source-of-truth where the schema is *also* a transformer. Effect Schema separates `Type` (decoded), `Encoded` (wire), and `Requirements`:

```ts
import { Schema } from "effect";
const Person = Schema.Struct({
  name: Schema.optionalWith(Schema.NonEmptyString, { exact: true }),
});
const decoded = Schema.decodeSync(Person)({ name: "Alice" });
const encoded = Schema.encodeSync(Person)(decoded);
```
([Effect Schema intro](https://effect.website/docs/schema/introduction))

The relevance for Singularity: a single schema can describe the wire shape, the DB shape, and the in-memory shape *and* the encoder/decoder between them — the same primitive that drives validation also drives migration codecs (issue #10).

## 4. Cross-framework comparison

| Framework | Schema location | Validation lib | Txn model | Optimism primitive | Conflict resolution | Migration story |
|---|---|---|---|---|---|---|
| Convex | `schema.ts` (`v.*`) | `v.*` (built-in) | Auto per mutation | `withOptimisticUpdate(localStore)` | Server-authoritative; rollback on settle | No SQL; dual-write pattern + `@convex-dev/migrations` |
| Replicache | KV; mutator signatures | None enforced | Server-side per mutator | Mutators always optimistic; rebase on pull | Re-run mutator against newer state | App-level — KV |
| Zero | `createSchema` + Zod on mutators | Zod / standard-schema | Per-mutator txn (client + server) | `defineMutator` runs both sides; client speculative | Server takes precedence on push echo | Drizzle migrations on the Postgres backing store |
| Triplit | `S.Schema` (shared) | `S.*` (built-in) | `client.transact` | Default — local-first writes | CRDT-ish + last-write-wins | Backwards-compat schema check on connect |
| TanStack DB + Electric | Per collection | User-supplied | `createTransaction` group | `collection.update` + `createOptimisticAction` | Handler throw → rollback; sync overrides | DB-side (Postgres) |
| Linear | MobX decorators | Per model | Transaction queue → server | Object-graph save = optimistic | Server-ordered `syncId`; LWW; CRDT for rich text | Server-controlled, opaque to clients |
| Prisma | `schema.prisma` | none built-in | Caller-managed | None native | n/a | Generated SQL files + `migrate deploy` |
| Drizzle (today) | `tables.ts` | drizzle-zod (opt-in) | Caller-managed | None native | n/a | drizzle-kit generated SQL + custom hash runner |
| Atlas | HCL / ORM-introspected | n/a | n/a | n/a | n/a | Diff-based versioned migrations from declarative state |
| TanStack Query | n/a | none | n/a | `onMutate` + `setQueryData` + `.undo` | App-level | n/a |
| RTK Query | n/a | none | n/a | `updateQueryData(...).undo` | App-level | n/a |
| Firestore | none | none | `runTransaction` (online only) | Default offline write queue | LWW per field | Schemaless |

## 5. Options for Singularity

Three concrete designs, each consistent with the architecture rules in `CLAUDE.md` (plugin barrels, no cross-plugin deep imports, Drizzle as the storage primitive). All three assume a separate sub-design solves live-query reactivity; here we focus only on schema + mutation + optimism.

### Option A — Drizzle-native `mutation()` primitive (smallest delta)

Keep Drizzle tables as the source of truth. Add a `mutation()` factory that wraps `(input → txn → emit)` so plugin authors stop writing `httpRoutes` + ad-hoc validation + manual `notify` calls.

```ts
// plugins/tasks-core/server/internal/mutations/create-task.ts
import { mutation } from "@core/sync";
import { createInsertSchema } from "drizzle-zod";
import { _tasks } from "../tables";

export const createTask = mutation({
  name: "tasks-core.createTask",
  input: createInsertSchema(_tasks, {
    title: (s) => s.trim().min(1).max(200),
    parentId: (s) => s.optional(),
  }),
  handler: async ({ tx, input, ctx }) => {
    const [row] = await tx.insert(_tasks).values({
      ...input,
      rank: await findNextRankUnder(tx, input.parentId ?? null),
    }).returning();
    return row;
  },
  // Optional: declarative optimistic patch — runs same input through pure fn.
  optimistic: ({ input, store }) => {
    const tempId = store.tempId();
    store.collection(_tasks).insert({ id: tempId, ...input, rank: Number.MAX_SAFE_INTEGER });
    return { tempId };
  },
});
```

The `mutation()` runtime:
1. Validates `input` with the derived Zod schema (issue #11).
2. Opens a Drizzle transaction, runs `handler({ tx, input })`.
3. Collects the set of tables touched via Drizzle's query log (or an explicit `tx.touched(_tasks)` API) and resolves the resources/queries that depend on them — using the *static* dependency graph from sub-design #2 (live-queries).
4. **Emits notifications inside the txn callback**, before commit returns to the caller, with one logical version stamp covering all touched resources (issue #4).

On the client side, the same `mutation()` definition is published via the API surface (sub-design #3) as `tasksCore.createTask({...})`. The optional `optimistic` callback runs synchronously and patches the live-query store; rollback is "remove all rows tagged with this in-flight mutation id" if the server returns `{ ok: false }` (issue #5).

**Schema migrations:** unchanged Drizzle workflow, with a new check that every `mutation()`'s `input` schema is derivable from the current table — caught by `./equin check`. No new migration framework yet (issue #10 only partially addressed).

**Tradeoffs.** Smallest blast radius — every `httpRoutes` entry becomes a `mutation()`. Optimism is opt-in per mutation rather than free. Migrations remain Drizzle-shaped, so issue #10 is only ~50% solved. Plugin authors keep their existing mental model (Drizzle table + handler) but gain validation + transactional notify + optional optimistic patch as a single primitive.

### Option B — Shared mutators (Replicache/Zero pattern), Drizzle on the backend

The mutator function is the unit and runs both places. Same code path on the client (against the IVM/cache store) and on the server (against Drizzle). Validators come from a shared schema (`drizzle-zod` derived OR Effect Schema, see option C).

```ts
// plugins/tasks-core/shared/mutators/create-task.ts
import { defineMutator } from "@core/sync";
import { z } from "zod";

export const createTask = defineMutator({
  name: "tasks-core.createTask",
  args: z.object({
    title: z.string().trim().min(1).max(200),
    parentId: z.string().nullable().default(null),
  }),
  async run({ tx, args, ctx }) {
    const id = ctx.id();
    const rank = await tx.tasks.nextRankUnder(args.parentId);
    await tx.tasks.insert({ id, title: args.title, parentId: args.parentId, rank });
    return { id };
  },
});
```

`tx` exposes a *typed projection of the schema* that works on both client (against the local store) and server (against Drizzle). On the client, calling `singularity.mutate.tasksCore.createTask({ title })` returns `{ client, server }` promises — `client` resolves immediately with the optimistic local result; `server` resolves with the canonical row. On reconnect / after pull, unconfirmed local mutations are rebased on top of the server state by re-running the mutator (issue #5 fully solved).

The server can override or wrap any mutator for server-only side effects (audit log, jobs):

```ts
// plugins/tasks-core/server/mutators/create-task.ts
import { defineServerMutator } from "@core/sync";
import { createTask as shared } from "@plugins/tasks-core/shared";

export const createTask = defineServerMutator(shared, {
  async run({ tx, args, ctx, base }) {
    const result = await base({ tx, args, ctx });
    await ctx.events.emit("tasks-core.taskCreated", { id: result.id });
    return result;
  },
});
```

**Tradeoffs.** Most powerful, biggest delta. Requires a client-side store that can run the mutator against an in-memory projection of the schema (some flavour of IVM or simpler "snapshot + patch"). Plugin authors must write shared mutators that don't touch server-only APIs (filesystem, jobs, secrets) — those go in `defineServerMutator` overrides. Solves issues #4, #5, and #11 completely; issue #10 still needs a separate migration story (but the shared schema makes "v1 mutator + v2 mutator coexist" much easier — just keep both registered for one release cycle, à la Convex dual-write).

### Option C — Schema-as-codec, Effect Schema source of truth

Replace Drizzle's table declarations with Effect Schema (or a thin wrapper) as the source of truth, then *derive* the Drizzle table, the migration plan (Atlas-style diff), the runtime validators, and the wire codec from the same declaration.

```ts
// plugins/tasks-core/shared/tables.ts
import { Table } from "@core/schema";
import { Schema as S } from "effect";

export const Task = Table("tasks", {
  id: S.UUID.pipe(S.brand("TaskId")),
  parentId: S.NullOr(S.UUID),
  title: S.String.pipe(S.trim, S.minLength(1), S.maxLength(200)),
  rank: S.Number.pipe(S.int(), S.positive()),
  createdAt: S.DateFromString,
  updatedAt: S.DateFromString,
}, {
  indexes: [["parentId", "rank"]],
});
```

The build step generates: a Drizzle table for runtime queries; a migration plan via Atlas-style diff against the deployed DB; an `Insert<Task>`, `Update<Task>` codec; per-field migration codecs for renames/type changes (`v1Field → v2Field`). Mutations are then defined either as Option A's `mutation()` or Option B's `defineMutator`.

**The migration win.** Schema changes are *one edit* — changing `S.String.pipe(S.maxLength(200))` to `300` widens the validator and triggers no SQL diff; renaming `title` to `name` produces a versioned migration *and* a codec entry that lets older clients keep speaking the old wire format until they update. Solves issue #10 holistically.

**Tradeoffs.** Largest scope. Needs a non-trivial codegen layer (or a runtime that introspects the Effect Schema → Drizzle bridge). High payoff if Singularity grows into a multi-tenant or multi-version-of-clients world; possibly over-engineered for the current single-process worktree model. Could be staged as a *follow-up* to Option A or B once the mutation primitive is in place.

### Recommendation

Start with **Option A** because it's the minimum viable structural fix — collapses HTTP handlers + ad-hoc validation + manual `notify` into one primitive without forcing a client-store rewrite. Keep Option B in mind as the eventual end-state once a real local store + IVM exists (sub-design #2). Treat Option C as a separable follow-up when migrations become a real pain (today the worktree-fork-DB model side-steps most pain).

The author-facing surface for Option A is small: one `mutation({ name, input, handler, optimistic? })` factory, plus a `useMutation()` hook that returns `{ mutate, isPending, isOptimistic, error }`. Every plugin's `httpRoutes` map collapses to a list of mutations and queries; no plugin author writes `notify()` again.

## 6. Open questions / dependencies

1. **Optimistic store shape (depends on sub-design #2 / live-query engine).** The optimistic patch needs a *local cache to patch into*. Today's `defineResource` returns whole snapshots, not row-addressable collections, so an optimistic insert can't be expressed as "add row X to collection Y". Either (a) the live-query engine adopts row-addressable collections (TanStack DB style) and Option A's `optimistic` callback becomes natural, or (b) we keep snapshot resources and optimistic updates remain expressed as `(prevSnapshot) => nextSnapshot` patches — workable but coarse.
2. **Mutator/handler split (depends on sub-design #3 / API surface).** Option B requires the mutator to be importable cross-runtime. The plugin-boundary rules say `@plugins/foo/shared` is the only place for cross-runtime code; mutators would live there, with server-only overrides in `@plugins/foo/server`.
3. **In-transaction notify ordering.** Emitting "resource invalidated" inside the Drizzle txn callback raises ordering concerns: subscribers shouldn't receive the notification until commit succeeds. Either we (a) buffer notifications and flush on commit (one-way coupling to the txn outcome), or (b) listen to Postgres `LISTEN/NOTIFY` for confirmed commits (clean, but couples sync to PG). Listed here, decided in sub-design #2.
4. **Mutation log / event sourcing.** Both Replicache and Linear keep a per-client *log* of pending mutations. Singularity could persist this in IndexedDB on the client and in Postgres on the server, which would also unlock undo/redo (issue #18) and "what did agent X do in the last hour" (issue #15). This is orthogonal to Options A–C but most natural to add atop Option B.
5. **Cross-plugin mutations.** A mutation in plugin A that writes to plugin B's table (e.g. `agents.createAgent` writing a meta-task into `tasks-core`) needs an explicit dependency edge — same problem as today's cross-plugin `notify`. The `mutation()` primitive can require declaring `tables: [Tasks, Agents]` so the plugin-boundary checker can verify that any cross-plugin write goes through the owning plugin's exposed mutation rather than reaching into its tables directly.
6. **Validator parity client/server.** drizzle-zod gives us *insert*-shape validators for free; *update* shape is trickier (partial + business rules). The mutation primitive must let the author refine the derived schema without re-typing it (`createInsertSchema(_tasks, { title: (s) => s.trim() })`). Effect Schema has stronger ergonomics here but is a bigger swap.
7. **Migration co-location with mutations.** A mutation that depends on a column being NOT NULL only works after the migration has run. Today these are two PRs; with Option A they're still two PRs but the mutation's input validator forces early failure if the schema rolls back. Worth a follow-up to make a mutation declare its required schema version.

---

**Sources cited inline.** Key references: [Convex schemas](https://docs.convex.dev/database/schemas), [Convex mutations](https://docs.convex.dev/functions/mutation-functions), [Convex optimistic updates](https://docs.convex.dev/client/react/optimistic-updates), [Convex migrations](https://stack.convex.dev/intro-to-migrations), [Replicache](https://doc.replicache.dev/concepts/how-it-works), [Zero mutators](https://zero.rocicorp.dev/docs/mutators), [Zero schema](https://zero.rocicorp.dev/docs/zero-schema), [Zero writing data](https://zero.rocicorp.dev/docs/writing-data), [Zero notes (Sólberg)](https://www.solberg.is/zero), [Triplit schemas](https://www.triplit.dev/docs/schemas), [Triplit schema updating](https://www.triplit.dev/docs/schemas/updating), [TanStack DB overview](https://tanstack.com/db/latest/docs/overview), [ElectricSQL writes](https://electric-sql.com/docs/guides/writes), [Linear sync engine (Fujimon)](https://www.fujimon.com/blog/linear-sync-engine), [Scaling the Linear Sync Engine](https://linear.app/now/scaling-the-linear-sync-engine), [Prisma Migrate](https://www.prisma.io/docs/orm/prisma-migrate), [Drizzle Zod](https://orm.drizzle.team/docs/zod), [Atlas declarative vs versioned](https://atlasgo.io/concepts/declarative-vs-versioned), [TanStack Query optimistic](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates), [RTK Query manual cache](https://redux-toolkit.js.org/rtk-query/usage/manual-cache-updates), [Firestore offline](https://firebase.google.com/docs/firestore/manage-data/enable-offline), [Effect Schema](https://effect.website/docs/schema/introduction).
