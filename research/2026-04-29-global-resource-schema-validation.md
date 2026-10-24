# Resource schema validation

> **Status (2026-06-08): complete + hardened.** Every resource now declares a
> schema, and `schema` is **required** on `defineResource` in both runtimes (no
> longer optional). The server also parses loader output against the schema at
> load time, so validation no longer depends on a client subscribing. See
> `research/2026-06-08-global-mandatory-resource-schema-server-validation.md`.

## Context

A crash hit on `/c/<id>/tasks` — `TypeError: e.getTime is not a function` thrown inside `formatRelativeTime`. Root cause: `attemptsResource` ships its payload as JSON over the wire, so `createdAt` arrives at the client as an ISO string, but the resource's TS type declares `Date`. The type system can't catch this — `T` is carried only on a phantom `__types` field that's never written at runtime, and `JSON.parse` doesn't reconstruct Dates.

Some consumers worked around this manually: `useConversations` parses the payload through a Zod schema before exposing it. Most consumers don't, and there's no enforcement. A point fix shipped (making `formatRelativeTime` tolerant of `Date | string`); the structural fix below closes the bug class.

Intended outcome: every resource carries a Zod schema that **defines** its payload shape. The TS type is derived from the schema (`z.infer`), so type and runtime can't drift. The client's `useResource` (queryFn fallback) and `NotificationsClient` (WS push) both `schema.parse` before the payload lands in the TanStack cache. Manual `Schema.parse(q.data)` calls become redundant.

## Approach

### 1. Schema-on-descriptor (the contract)

Add a required `schema: ZodType<T>` field to the descriptor types and have `T` be inferred from the schema (so the type and the parser cannot drift):

- `plugins/primitives/plugins/live-state/shared/resource.ts:6-22` — add `schema` to `ResourceDescriptor<T,P>`; change `resourceDescriptor` / `centralResourceDescriptor` factories at lines 12, 18 to take `(key, schema)` and return a descriptor whose `T` is `z.infer<typeof schema>`.
- `server/src/resources.ts:29-46, 90` — add `schema` to `ResourceDefinition<T,P>`; have `defineResource` infer `T` from the schema and constrain `loader` to return `Promise<z.infer<S>>`.
- `central/src/resources.ts:71` — line-for-line mirror of the server change (the comment at central:6-8 documents the duplication).

The descriptor lives in `shared/` so both client and server see it. Server `Resource<T,P>` structurally satisfies the client's `ResourceDescriptor<T,P>` — adding `schema` to both keeps that contract.

### 2. Parse on the client at both write paths

Two places where data lands in the TanStack cache; both need the parse.

**a. queryFn HTTP fallback** — `plugins/primitives/plugins/live-state/web/use-resource.ts:82-94`

```ts
queryFn: async () => {
  ...
  const body = (await res.json()) as { value: unknown; version: number };
  return resource.schema.parse(body.value);
}
```

**b. WS notification path** — `plugins/primitives/plugins/live-state/web/notifications-client.ts:175`

`NotificationsClient` is descriptor-agnostic today (it only sees `key` strings, raw `value: unknown`). Plumb the schema in via `observe()`, which `useResource` already calls on subscribe:

```ts
// use-resource.ts: pass schema along
notifications.observe(key, p, origin, resource.schema);

// notifications-client.ts: keep a key→schema registry
private schemas = new Map<string, ZodType>();
observe(key, params, origin, schema) {
  this.schemas.set(key, schema);  // same key always pairs to the same schema
  ...
}
private applyUpdate(key, params, value) {
  const schema = this.schemas.get(key);
  const parsed = schema ? schema.parse(value) : value;
  this.queryClient.setQueryData(queryKeyFor(key, params), parsed);
}
```

This covers both `sub-ack` (always carries full value) and push-mode `update` messages, which both route through `applyUpdate` (`notifications-client.ts:162-175`). `mode: "invalidate"` resources don't carry a value over WS — they trigger a refetch and parse via path (a).

The `schema ? : value` fallback in `applyUpdate` exists only for the in-flight migration window; the field is required at the type level so it'll be present once every resource is migrated.

### 3. Migrate every resource (one PR)

17 resources, three buckets by schema readiness. Per-bucket changes are mechanical: add a `schema` field referencing an existing or newly-extracted Zod schema.

**Bucket A — existing primitive schema, just wrap with `z.array` (5):**
- `tasksResource` (`plugins/tasks-core/server/internal/resources.ts:86`) → `z.array(TaskSchema)` (`plugins/tasks-core/server/internal/schema.ts:195`)
- `pushesResource` (resources.ts:49) → `z.array(PushSchema)` (schema.ts:221)
- `agentsResource` (`plugins/agents/server/internal/resources.ts:15`) → `z.array(AgentSchema)` (`plugins/agents/server/internal/schema.ts:18`)
- `yakShavingNodesResource` → `z.array(YakShavingNodeSchema)` (`plugins/yak-shaving/server/internal/schema.ts:7`)
- `yakShavingCategoriesResource` → `z.array(YakShavingCategorySchema)` (schema.ts:13)

**Bucket B — composite schema needs to be authored (3):**
- `attemptsResource` (resources.ts:56): author `ConversationSummarySchema = ConversationSchema.pick({ id, title, status, kind, createdAt, spawnedBy })` and `AttemptWithConversationsSchema = AttemptSchema.extend({ conversations: z.array(ConversationSummarySchema) })`. Co-locate beside the existing type at `plugins/tasks-core/shared/index.ts:29-35`. Resource schema is `z.array(AttemptWithConversationsSchema)`.
- `recentConversationsResource` (resources.ts:28): the schema already exists inline at `plugins/conversations/web/use-conversations.ts:8` (`PayloadSchema`). Move it to a shared module (`plugins/conversations/shared/`) and reference from both the resource and the now-redundant consumer.
- `agentLaunchesResource` (`plugins/agents/server/internal/resources.ts:22`): author `AgentLaunchWithStatusSchema = AgentLaunchSchema.extend({ latestConversationStatus: ConversationStatusSchema.nullable(), latestConversation: AgentLaunchConversationRefSchema.nullable() })` near `plugins/agents/server/internal/schema.ts`.

**Bucket C — needs a brand-new schema (1 Date-bearing + ~8 hygiene):**
- `crashesResource` (`plugins/crashes/server/internal/resources.ts:6`): write `CrashSchema` from the `_crashes` table (mirror existing tables-core pattern with `z.coerce.date()` on `firstSeenAt`/`lastSeenAt`/`createdAt`/`updatedAt`).
- No-Date payloads (hygiene only — no live bug, but uniform required schema): `conversationSummariesResource` (already has `ConversationSummarySchema` at `plugins/conversations/plugins/summary/shared/resources.ts:16` — reuse), `editedFilesResource`, `jsonlEventsResource`, `pushAndExitResource`, `forkErrorsResource`, `configResource` (use `z.record(z.unknown())` — payload is genuinely opaque), `configSecretsResource`, `authStateResource` (central), `excludedPathStateResource`, `quickPromptsResource`.

### 4. Delete redundancies

- `plugins/conversations/web/use-conversations.ts:40` — drop the `PayloadSchema.parse(q.data)` line and collapse the wrapping `useMemo` (or keep the `useMemo` purely for the `isLoading` shape). `q.data` is already coerced.
- The agent rule comment at `use-resource.ts:56-59` ("Never cast the data returned by useResource") stays — its rationale strengthens: `T` now derives from the schema, so casting silently bypasses validation that's actually doing work.
- The `__types` phantom at `shared/resource.ts` is no longer needed (T is inferred from `schema`). Remove.

### 5. YAGNI — validated-transport escape hatch

Some future resource may be large enough that Zod-parsing every push hurts. Note in `plugins/primitives/plugins/live-state/CLAUDE.md` that the future escape hatch is a `transform: (raw) => T` field that bypasses Zod for hot paths. Do **not** implement now — current payloads are small and parse cost is negligible.

## Files to modify

**Infra:**
- `plugins/primitives/plugins/live-state/shared/resource.ts`
- `plugins/primitives/plugins/live-state/web/use-resource.ts:82-94`
- `plugins/primitives/plugins/live-state/web/notifications-client.ts:166, 175`
- `plugins/primitives/plugins/live-state/CLAUDE.md` (document the contract + transport-escape note)
- `server/src/resources.ts:29-46, 90`
- `central/src/resources.ts:71`

**Resource definitions (17 sites add `schema:` field):**
- `plugins/tasks-core/server/internal/resources.ts` (×4)
- `plugins/agents/server/internal/resources.ts` (×2)
- `plugins/crashes/server/internal/resources.ts`
- `plugins/yak-shaving/server/internal/resources.ts` (×2)
- `plugins/conversations/plugins/summary/server/internal/resources.ts`
- `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/edited-files-resource.ts`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/server/internal/jsonl-events-resource.ts`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/push-and-exit-job.ts:45`
- `plugins/conversations/server/internal/fork-errors.ts`
- `plugins/config/server/internal/resource.ts`, `.../secrets-resource.ts`
- `plugins/auth/central/internal/auth-resource.ts:5`
- `plugins/stats/plugins/commits/server/internal/excluded-paths.ts`
- `plugins/conversations/plugins/conversation-view/plugins/quick-prompts/shared/resources.ts:15`

**New schema modules:**
- `ConversationSummarySchema`, `AttemptWithConversationsSchema` → near `plugins/tasks-core/shared/index.ts`
- `AgentLaunchWithStatusSchema` → near `plugins/agents/server/internal/schema.ts`
- `CrashSchema` → `plugins/crashes/server/internal/schema.ts` (new)
- Promote `PayloadSchema` from `use-conversations.ts:8` into `plugins/conversations/shared/`

**Cleanup:**
- `plugins/conversations/web/use-conversations.ts:40`
- The `formatRelativeTime`/`ConversationItemConv` `Date | string` tolerance shipped earlier can be reverted — once `attemptsResource` parses through `AttemptWithConversationsSchema` (with `ConversationSummarySchema` using `z.coerce.date()` on `createdAt`), the runtime is a real `Date` again. Worth doing as the last commit of the migration to assert the fix took hold.

## Verification

1. `./equin build` — TS compile across all touched plugins. The `T = z.infer<typeof schema>` derivation makes shape drift between schema and loader return a static error; this is the safety net the system was missing.
2. Revert the `formatRelativeTime`/`ConversationItemConv` `Date | string` tolerance, then visit `http://<worktree>.localhost:9000/c/<id>/tasks` and confirm no crash. (If the structural fix is correct, the point fix is no longer needed.)
3. Spot-check one consumer per resource group with the dev tools open:
   - Tasks list (`tasksResource`) — sidebar + tree
   - Conversations sidebar (`recentConversationsResource`) — relative-time strings render
   - Task events (`attemptsResource`, `pushesResource`) — push timestamps render
   - Agent launches (`agentLaunchesResource`)
   - Settings (`configResource`)
4. Cause a WS reconnect (`./equin build` restarts the server) — exercises the queryFn-fallback path; confirm it parses too.
5. Add one focused unit test in `plugins/primitives/plugins/live-state/web/notifications-client.test.ts`: instantiate `NotificationsClient`, simulate an `update` message with `createdAt` as an ISO string, assert `queryClient.getQueryData(...)` returns a value where the field is a real `Date`.
