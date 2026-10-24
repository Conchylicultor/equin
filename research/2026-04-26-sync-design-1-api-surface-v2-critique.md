# Sync engine sub-design 1 (v2) — Critique against real plugins

> Companion to [`2026-04-26-sync-design-1-api-surface-v2.md`](./2026-04-26-sync-design-1-api-surface-v2.md). This doc reimplements representative current plugins against the proposed five-symbol surface (`definePluginApi`, `query`, `mutation`, `useQuery`, `useMutation`) and lists the gaps that surfaced.
>
> Method: rewrote `quick-prompts` (trivial CRUD), `tasks-core` (multi-resource cascade + internal mutations), `agents` (cross-plugin `call`), `jsonl-viewer` (parameterised + non-DB watcher), `conversations.create` (orchestration with side effects), and `push-and-exit` (durable workflow). Issues below are grouped: **blocking** (the rewrite cannot be written honestly), **leaky** (the rewrite works but introduces a new tension the v1 surface didn't have), and **specify-now** (deferred to a sibling sub-design, but reserving the slot now costs nothing and avoids a breaking change later).

## Verdict in one paragraph

The common case (quick-prompts, agents CRUD, tasks-core listings) collapses cleanly: the four-resource DAG in `tasks-core` evaporates, the triple `notify()` in `adoptOrphanConversation` evaporates, and the symbol count for a typical plugin drops by ~70 %. **Four issues are blocking** before a plugin author can write the full set of today's plugins against this surface — the most load-bearing being that `mutation` body = one tx is wrong for half of the real mutations (`conversations.create` mixes DB writes with `git worktree add`, `pg_dump | pg_restore`, and `tmux new-window`, none of which roll back). Two further issues are specify-now: reserving `ctx.identity` and clarifying `Sync.emit` vs `events.trigger`.

---

## Blocking

### B1 — No home for per-subscription lifecycle

`jsonl-viewer` today opens a 500 ms file watcher in `onFirstSubscribe({ id })` and tears it down in `onLastUnsubscribe({ id })`. The v2 `query` shape is `{ input, handler, invalidatesOn? }` — no lifecycle slots.

The `Sync.emit("fs:transcript:…")` escape hatch (§5) addresses *how invalidation fires*, but not *who starts the watcher in the first place*. Same pattern: `terminal` (open pty on connect), `logs` (tail file on subscribe), and any future git-watch / file-watch resource.

Fix options, both of which break the "5 symbols total" promise:
- (a) Add `onFirstSubscribe`/`onLastUnsubscribe` to `query` → grows the per-query surface to 5 fields.
- (b) Commit to a sibling `defineSource(tag, { onFirstSubscribe, onLastUnsubscribe })` primitive → 6 top-level symbols.

Recommend (b): keeps `query` clean and gives non-DB tag sources one first-class declaration.

### B2 — "mutation body = one transaction" breaks for half the real mutations

`conversations.create` mixes inside one logical operation:

| Step | Reversible by tx rollback? |
|---|---|
| `tx.insert(_conversations)` | ✅ |
| `setupWorktree()` (`git worktree add`) | ❌ |
| `forkDatabase()` (`pg_dump | pg_restore`, fire-and-forget) | ❌ |
| `runtime.create()` (`tmux new-window`) | ❌ |

Three resolutions, none in the doc:

1. **Forbid side effects in `mutation`** → forces splitting into mutation + post-commit + (escape hatch) action. Convex's three-kind split (`query`/`mutation`/`action`) re-emerges; we're back to 3 verbs.
2. **Allow side effects, no rollback** → silent orphans on commit failure. Worse than today, where the author orders the steps by hand.
3. **Saga / outbox** (queue side effects via `jobs`, commit row as "pending") → a pattern the surface doesn't teach.

This is a surface-level decision, not a sub-design 4 detail: it changes what an author writes inside `handler`. Recommend either a third verb (`action`) or a `ctx.afterCommit(fn)` slot — and stop describing the surface as 2 verbs until that lands.

### B3 — Internal-only mutations have no declaration

`tasks-core` exports `createTask`, `findNextRankUnder`, `backfillMetaParent`, `getAttempt`, `listAttempts` etc. as plain TS functions called directly by other plugins. They are not web-callable. In the v2 world:

- If they become `mutation()`s inside `definePluginApi`, they get a wire route, input schema, optimistic tooling — **and the right to be invoked from any browser tab**. Conceptual + security regression.
- If they stay as plain functions, two surfaces coexist per plugin (`api` and the legacy direct-export utility layer). The "5 surfaces → 2" claim doesn't actually hold.

Recommend an `internal: true` flag on `mutation`/`query` (or a separate `internalApi` namespace) so the producer side can express "callable via `call` but not over the wire". `./equin check` enforces no wire route generated.

### B4 — Wire boundary assumes JSON in/out

`attachments` (multipart upload), `code-explorer` image route, attachment download — none of these are JSON. The v2 surface implicitly assumes JSON; a `mutation` returning a `Response` (binary, redirect, custom headers) has no slot.

Options:
- Permit `httpRoutes` as a documented escape hatch (then we still have 2 surfaces, just rebalanced).
- Polymorphic mutation return: `Promise<T | Response>` — ugly but works.

Either is fine. Picking neither leaves attachments stranded.

---

## Leaky

### L1 — `call(otherPlugin.create, …)` shares a tx — but the consequences are large and undocumented

`agents.launch` → `tasksCoreApi.createTask` → … The doc says "B inherits A's tx". Three downstream consequences buried in that sentence:

- Every `mutation` is silently **re-entrant** with respect to the enclosing tx. Authors who don't know that will reach for `tx.commit()` patterns that don't exist.
- A mutation that worked safely as a top-level call may misbehave as a sub-step (e.g. "schedule a job only at top level"). The author needs a way to detect "am I being called?".
- When `agents.launch` calls `conversations.create` (issue B2's trifecta), **whose** commit point governs `runtime.create()`? The outer tx? The doc doesn't say.

Recommend stating explicitly: "`call` always opens a savepoint; `ctx.isNested: boolean` is part of the handler context".

### L2 — Read-set tracking has cliffs the doc dismisses

The 3-verb → 2-verb collapse depends entirely on the engine seeing the reads. Real cases that escape:

- `db.select(...).where(isActive(_conversations.status))`. Helper-returns-SQL is fine; helper-returns-`or(eq, eq, …)` is fine; the day someone writes `db.execute(sql\`select … where status in ${active}\`)` for perf, **read-set tracking silently stops working** and the UI goes stale. Today this would be obvious (forgot `dependsOn` → reviewer catches it). Tomorrow, invisible.
- `agents.launches` does `call(tasksCoreApi.listConversations)`. The engine has to attribute the callee's reads to the caller's tracked set. Doable, but worth saying.
- Granularity (row / range / table) is "the engine's call" per the doc — but it determines both correctness and cost without changing author code. A linter that flags `db.execute`/raw SQL inside `query` handlers should ship in v1.

### L3 — Background work has no place in the surface

`poller` (1 s tick) and `turn-emitter` (500 ms tick) in conversations are neither queries nor mutations. They reconcile DB state with live tmux state. In v2 they'd call `tasksCoreApi.adoptOrphanConversation` (a mutation) — which is fine — but:

- The poller is triggered by time, not by a request. Where does it live? `onReady` only?
- The turn-emitter emits a typed event consumed by a durable job. That channel is the existing `events` plugin. **`Sync.emit(tag)` and `events.trigger(name)` are two different emit verbs with overlapping semantics** — worse than today's single `notify()`.

Recommend §3.5 or §6.3: "`Sync.emit` is invalidation-tag only; cross-plugin event dispatch stays on `events.defineTriggerEvent`". Or unify. Don't leave it ambient.

### L4 — Cross-worktree fan-out is unaddressed

`auth.fanoutInvalidate` POSTs `http://<name>.localhost:9000/api/auth/invalidate` to every other worktree. `Sync.emit(tag)` is process-local; v2 has no concept of "this invalidation should fan out to every worktree". Today's code leans on `fetch` between worktrees, which is in scope for B4 above but also needs a *broadcast* primitive.

Sub-design 5 names "multi-process broadcast" — but the surface needs to expose `Sync.emit(tag, { multiProcess: true })` (or split into two verbs) *now*, because changing it later changes call sites.

### L5 — Streaming punted; surface covers ~70 % of what plugins do

`wsRoutes` for terminal, log channels, and jsonl-viewer's underlying file stream are explicitly out of scope per §8 Q2. Of today's five surfaces, **streaming is a sixth surface that survives untouched.** The "two systems pretending to be one" headline becomes "three systems": queries, mutations, and event streams.

This is fine as a pragmatic v1 cut, but it should be stated in §1, not §8.

### L6 — Optimistic API is one chained method, not a spec

```ts
useMutation(agentsApi.create).optimistic((cache, input) => {
  cache.update(agentsApi.list, { parentId }, rows => [...rows, { id: "tmp", ...input }]);
});
```

Three holes worth flagging:

1. **ID rebind.** When the real row arrives via read-set invalidation, `id="tmp"` → `id="agent-…"`. React keys it as a different row; drag-and-drop, animations, focus on the new row break unless there's an explicit ID-rebind primitive.
2. **Cross-plugin optimism.** `agents.launch` writes to `_agent_launches` *and* causes a conversation insert visible to `tasksCoreApi.listConversations`. Each plugin's optimistic patch is local; there's no shared speculative tx the way Replicache/Zero have.
3. **Rollback** — punted to sub-design 4. Fine, but "optimistic updates" is currently a marketing bullet, not a specced primitive.

---

## Specify now (cheap reservations)

### S1 — Reserve `ctx.identity` in the handler shape

`createConversation` requires `spawnedBy` (today: env var or explicit). A browser caller has no `SINGULARITY_WORKTREE`; threading the value through means every web caller passes a string the server already knows. The v2 surface has no `ctx.identity`, no `ctx.actor`, no `ctx.requestSource`. v1 punts to a future sub-design 6.

Cost of reserving `ctx.identity` now: zero. Cost of adding it later: every handler signature changes. Reserve the slot in v2, leave it `undefined` for now.

### S2 — `call` value resolution is ambient

`call(conversationsApi.create, …)` works because the proxy carries `"conversations.create"` and the runtime registry resolves it. If `conversations` isn't loaded (test env, partial build), runtime error, no compile signal. Today's direct-import (`import { createConversation } from "@plugins/conversations/server"`) link-checks.

`./equin check` should enforce "every `call(target, …)` target's plugin is in the active plugin set". Cheap to add now; harder once `call` is used widely.

### S3 — Naming pick (§8 Q3)

The doc lists `definePluginApi` / `defineRouter` / `pluginRouter` / `defineSync` / `defineApi`. Pick `definePluginApi` and move on. Mirrors `definePlugin` and `defineConfig`. Bikeshedding cost is small but the cost of changing it after the first 10 plugins is non-zero.

---

## What the surface actually covers, honestly

Once B1–B4 are resolved, the verb count is **2 + 1 (`action` or `afterCommit`) + 1 (`defineSource` for stream watchers)** = 4 declaration verbs, plus the two hooks. That's still a clear win over today's 5+ surfaces — but the v2 headline "5 symbols total / 2 verbs" should be retired. The honest claim is:

> Three declaration verbs (`query`, `mutation`, `action`), one source primitive (`defineSource`), two React hooks (`useQuery`, `useMutation`), and one emit verb (`Sync.emit`). Streaming WS routes (`wsRoutes`) stay out of scope.

Seven symbols. Still half of today. That's the win to sell.

---

## Files reimplemented during this critique

- `quick-prompts` — clean win, no caveats.
- `tasks-core` — clean win for the 4-resource DAG; B3 (internal-only declaration) needed for `createTask`/`findNextRankUnder`/etc.
- `agents` — clean for CRUD; L1 (savepoint semantics of `call`) needs spec.
- `jsonl-viewer` — **blocked on B1**.
- `conversations.create` — **blocked on B2**.
- `push-and-exit` — out of scope for v2 (correctly); the body lives in `jobs`. Confirm boundary in §9.
