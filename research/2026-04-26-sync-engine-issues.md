# Issues with the current sync system

Catalogue of pain points in the existing data/sync layer (`server/src/resources.ts`, `defineResource`, `notify`, `useResource`, the per-plugin HTTP route maps, and the surrounding DB conventions). This doc lists problems only — design responses live elsewhere.

## 1. Reactivity is manual and fragile

- Every mutation must remember to call `resource.notify()` on every resource its writes can affect. Forgetting is silent: the DB is correct, the UI is stale until refresh.
- The set of resources to notify is implicit knowledge in the author's head. There's no static check that a code path that writes table `T` notifies all resources whose loader reads `T`.
- The same logical write is split across N notify sites (see `agents` create/update/delete each calling `agentsResource.notify()`). Adding a new field that participates in a new resource means hunting every write site.
- Cross-plugin writes are worse: plugin A writes a row that plugin B's resource depends on. A has to know about B's resource to notify it, breaking plugin isolation.

## 2. The `dependsOn` graph is hand-drawn and easily wrong

- `tasksResource` declares `dependsOn: [attemptsResource]`, `attemptsResource` declares `dependsOn: [recentConversationsResource, pushesResource]`. Each edge is asserted by hand.
- A loader can read a table that isn't reflected in `dependsOn` — the type system can't catch it. The resource then silently fails to update on changes to that table.
- Conversely, over-broad `dependsOn` causes loader re-runs that do nothing — wasted CPU and wasted bandwidth.
- The `map` function on dependency edges (param-to-param projection) is yet another place where hand-written logic must stay in sync with the loader.

## 3. Granularity is coarse: full payloads, not row deltas

- `mode: "push"` resends the entire payload on any change. A 500-task list re-serializes and re-broadcasts because one task title changed.
- `mode: "invalidate"` is a refetch hint, so the client immediately HTTPs the whole payload back. Same coarseness, just split across two round trips.
- There's no notion of "row X changed in collection Y" at the wire level. Clients can't diff cheaply; React reconciles a re-rendered list because reference identity changes.
- Pagination is impossible without baking it into the loader's params, and even then a write anywhere in the page invalidates the whole window.

## 4. No transactional consistency between writes and notifications

- A multi-table write isn't wrapped in a DB transaction in user code; if step 2 fails after step 1 succeeds, the DB is half-applied and at least one notify still fires.
- Even if a write is transactional, the `notify` is fire-and-forget post-commit. Two notifies from concurrent mutations can interleave such that subscribers see resource A's new state alongside resource B's old state — there is no "snapshot" guarantee across resources that should logically agree.
- The microtask flush coalesces notifies but doesn't tie them to a transaction boundary. A reader can subscribe mid-flush and get one resource at version N and another at N-1.

## 5. Optimistic updates are not a primitive

- Mutations are plain `fetch('/api/...')` calls. The UI waits for the round trip, then waits for the WS push, then re-renders.
- Components either accept the latency or roll their own optimistic state with `useState` shadow copies and reconciliation on the WS update. There is no shared pattern; every plugin reinvents it badly or skips it.
- Rollback on mutation failure is entirely ad-hoc. Toast on error, hope the WS payload corrects the UI.

## 6. The HTTP layer is a parallel, untyped contract

- Every plugin writes `httpRoutes: { "POST /api/foo": handleCreate, ... }` and matching client `fetch('/api/foo', { method: 'POST', body: JSON.stringify(...) })`. The two sides are linked by string.
- Request/response shapes are duplicated: a Zod schema in `shared/`, manual `as` casts in handlers, manual JSON parsing in clients. Drift is silent until runtime.
- Error shapes are inconsistent: `Response.json({ error: "..." }, { status: 400 })` vs `new Response("Missing id", { status: 400 })` vs thrown exceptions. Clients string-match.
- Path params are typed `Record<string, string>` everywhere. No compile-time guarantee a handler reads the param it expects.
- We're maintaining two namespaces in parallel — `httpRoutes` for writes, `resources` for reads — when they're describing the same domain.

## 7. The descriptor / type-bridge dance

- For each resource, the server defines `defineResource({ key: "foo", loader, ... })` and the shared layer defines `descriptor<T>("foo")` so the web side can type the payload without importing server code. The two declarations share only a string key.
- Renaming a key breaks at runtime, not compile time. Changing the payload type on the server doesn't propagate to the descriptor unless the author remembers to update the shared file.
- This is a workaround for the lack of end-to-end type inference between server functions and React hooks.

## 8. Subscriptions don't survive disconnects cleanly

- The WS reconnect path resubscribes everything, but during the gap, mutations land and the client never sees the intermediate updates — it gets the new value and a version jump. Fine for `push`, broken for any consumer that wanted to react to the *transition* (animations, toasts on row delete, etc.).
- There's no replay log. "What happened while I was offline" is unanswerable; the client just gets the current truth.
- Heartbeat / liveness is per-WS. There's no per-subscription health signal, so a stuck loader on the server looks identical to a healthy idle subscription.

## 9. Authorization has no place to live

- Every handler is `(req: Request) => Promise<Response>`. Read auth, write auth, rate limiting, audit logging — all would have to be re-implemented per-handler.
- Resource loaders run server-side with full DB access, no caller context. Even if Singularity grew a notion of identity, the loader has nowhere to receive it.
- The single-user/local assumption is baked into the absence of an auth layer, not into a deliberate "no-auth" mode that could be flipped.

## 10. Schema migrations are a separate, fragile track

- Drizzle schema lives next to plugins in `<plugin>/server/internal/tables.ts`. Migrations are generated by `drizzle-kit generate` and stored in `server/src/db/migrations/`. The custom hash-keyed runner in `server/src/db/migrate.ts` handles parallel agent branches, but the developer ergonomics are: edit schema → run `./equin build` → commit the generated SQL → hope the hash collides correctly across worktrees.
- Schema changes are not co-located with the resources that read them. Adding a column means editing tables.ts, regenerating migrations, updating the loader, updating `dependsOn` if the column comes from a new table, updating the descriptor, updating client consumers. Five places, no single source of truth.
- Backfills are hand-written SQL, not part of the type system. Field renames are a multi-step dance.

## 11. No write-time validation primitive

- Handlers parse `req.json()` with `.catch(() => ({}))` and validate field-by-field with `typeof body.title !== "string"`. Some plugins use Zod, some don't.
- The DB schema (Drizzle) and the request schema (ad-hoc) are not connected. A `.notNull()` column is enforced only by Postgres erroring at insert time.
- Default values, normalization (e.g. `title.trim()`), and required-field checks live wherever the author put them. Same plugin can have different rules across create/update.

## 12. Resources can't compose with non-DB sources

- `defineResource.loader` is "run a query, return JSON". A resource backed by reading a file (`findTranscriptPath`), watching a directory, or calling out to git (`git log` for stats) doesn't fit cleanly: it works, but there's no "notify me when this filesystem path changes" trigger feeding the resource — the consumer has to manually call `notify()` from wherever the underlying change happens.
- The boundary between "DB-backed live data" and "computed-from-the-world data" is invisible in the API. Both look like resources; only one is genuinely reactive.

## 13. Per-resource loader cost on every change

- A push-mode resource's loader runs on every notify, even if the change is one row in a thousand-row payload. There's no incremental update — the loader returns the full snapshot from scratch.
- Loaders that join across multiple tables (e.g. `attemptsResource` building a per-attempt conversation map) re-do the entire join on each tick. Caching is per-loader, ad-hoc, or absent.
- Multiple subscribers to the same `(key, params)` share one loader run, but multiple subscribers to *related* params (e.g. one task at a time, viewed by 3 tabs) each get their own loader run.

## 14. No query-time parameters beyond what the loader hardcodes

- A resource is `(key, params) → value`. Want to filter, sort, or paginate? Encode it in `params`. Now every distinct filter combination is a separate cache entry on the server and the client.
- There is no concept of "give me rows where status='open' as a live query" — you'd define a resource per status, or load everything and filter in the client.
- Joining across plugins requires a meta-resource that depends on both — added by hand, with the same `dependsOn` brittleness as §2.

## 15. Debuggability is thin

- "Why didn't my UI update?" has many answers: the loader didn't read the table you wrote, you forgot to notify, the WS dropped, the version coalesced, the dependsOn edge was missing, the client cache key changed under you. There's no per-mutation trace showing "this write touched these resources, fired these subscribers, at this version".
- The Queue debug pane shows jobs and triggers. There's no equivalent for resources/subscriptions: which clients are subscribed to what, last value, last loader duration, fan-out cost.

## 16. WebSocket is the only transport

- Server-to-client streaming is fine over WS, but every page load opens a WS to receive the initial payload that already came over HTTP. Two paths for the same data, two sets of bugs (HTTP returns `{ value, version }`, WS sends `{ kind, value, version }`).
- No HTTP/2 server push, no SSE fallback, no progressive enhancement. A reverse proxy that buffers WS frames stalls the whole sync.
- Bun's WS implementation, the gateway's WS proxy, and the SharedWebSocket primitive are three layers that can each independently break in ways the others can't see.

## 17. Plugin boundary leakage

- The plugin-boundary checks (`./equin check --plugin-boundaries`) enforce import paths but can't enforce notify-correctness. A plugin can write to its own table without notifying a resource defined in another plugin that reads it — and the rules say the writing plugin shouldn't even know about the other plugin's resource. The system encourages either boundary-violation or stale UI; there's no third option.
- Conversely, resources that legitimately span plugins (`attemptsResource` reading conversations) need explicit `dependsOn` edges into other plugins' resources, leaking knowledge upward.

## 18. Forking, branching, and time-travel are absent

- Each worktree gets its own DB via `pg_dump | pg_restore`, but inside a worktree there's no concept of "branch this state, try a mutation, throw it away". An agent that wants to speculate ("what if I rename these 50 tasks?") has to write and roll back manually.
- No undo/redo at the data layer. Every plugin reimplements it (or doesn't).
- No event sourcing or write-ahead log we can replay. "What did agent X do in the last hour?" is answerable only via app-specific logs.

## 19. Single-process assumption

- Resources, jobs, events, and the WS broker all live in one Bun process per worktree. Scaling reads to multiple processes (or even multiple tabs sharing a worker) means broadcasting writes externally — there's no story for that.
- A long-running loader blocks the event loop and slows every other subscriber's notify flush.

## 20. The mental model is two systems pretending to be one

- Reads are reactive (resources + WS). Writes are imperative (HTTP + manual notify). Plugin authors hold both models in their head and translate between them on every feature.
- A single primitive — "describe the data, get reads + writes + sync for free" — would replace `defineResource` + `httpRoutes` + descriptor + `useResource` + `fetch(...)`. Today these are five surfaces moving in loose lockstep.
