# Stream the worktree-cleanup list (plugin-local NDJSON helpers)

## Context

`http://equin.localhost:9000/debug/worktree-cleanup` fails with a cryptic
`SyntaxError: Unexpected token 'b', "backend un"... is not valid JSON`.

Root-cause chain (all confirmed):

1. `GET /api/debug/worktrees` builds the whole list in one request: for each of
   ~2082 attempts it stats the worktree dir and runs a `git status` subprocess.
   With **1257 live worktrees** (~0.165s/git even idle, slower under load), the
   handler needs ~20s+ before its first byte.
2. Bun's default **`idleTimeout` is 10s**. With no bytes sent for 10s, Bun aborts
   the request and closes the socket (gateway log: `request timed out after 10 seconds`).
3. The gateway reverse proxy sees the dropped upstream and returns plain-text
   `backend unavailable: EOF` HTTP 502 (`gateway/worktree.go:643`).
4. The panel's hand-rolled `fetch` called `res.json()` **without checking
   `res.ok`**, so `JSON.parse` choked on the `b` in "backend" — and, by bypassing
   the endpoints primitive, the failure was never reported to the `crashes` plugin
   (answering "why isn't it in the crash report?").

Two defects: (a) a client that mishandles + silently drops non-JSON HTTP errors;
(b) an endpoint that can't finish inside the 10s idle window. The fix for both is
to **stream the list as NDJSON** so the connection stays alive and rows render
progressively at any worktree count.

### Why plugin-local, not a framework primitive

We considered extracting a generic streamed-list primitive into the `endpoints`
plugin. A consumer hunt killed that idea:

- The **task list** — the obvious "big list" — is **live-state push**
  (`tasksResource = defineResource({ mode: "push" })`, `plugins/tasks-core/server/internal/resources.ts:84`),
  delivered over `/ws/notifications`. The client always has the array cached; its
  cost is `tasks_v` SQL recompute, not transfer. Streaming can't help it. This is
  the codebase's idiom: **reactive lists are live-state resources, not streamed HTTP.**
- The slowest endpoint (cost-stats bundle, ~1000 JSONL reads) returns *charts*,
  not a row list — it wants a *progress* stream, not a list stream.
- review/plugin-changes is bounded-N with up-front cost; deploy/plugin-health
  lists are tiny-N. None approach 10s.

So the only streamed-HTTP consumer is worktree-cleanup. The **real** duplication
is *inside this one plugin*: its list handler (new) and its delete handler
(existing) both need a server NDJSON emitter and a client reader with the `res.ok`
guard + crash-report hook. That's a 2-consumer dedup local to the plugin — fix it
there, and promote to `endpoints` only when a *second plugin* needs streaming.

## Design — two small helpers in the worktree-cleanup plugin

### Wire mechanism (shared by list + delete)

NDJSON (`application/x-ndjson`): one JSON object per line. The helpers own the
*mechanism* (ReadableStream encode / guarded read); each handler owns its *frame
semantics*:

- **list** frames: `{"item": <WorktreeEntry>}`, terminal `{"end": true}`, `{"error": "<msg>"}`
- **delete** frames (unchanged shapes): `{"step": ...}`, `{"ok": true}`, `{"ok": false, "error": ...}`, `{"error": "<msg>"}`

The required terminal `end` sentinel on the list makes a dropped socket *fail
loudly*: no `end` / `error` → client throws "stream truncated" instead of
rendering a partial list as complete.

### New file 1 — `shared/ndjson.ts` (runtime-agnostic server emitter)

```ts
// Wraps a producer into a streaming NDJSON Response. The producer emits frames;
// an unexpected throw is framed as {"error": message}; the stream always closes.
export function ndjsonResponse(
  produce: (emit: (frame: object) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (frame: object) =>
        controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
      try { await produce(emit); }
      catch (e) { emit({ error: e instanceof Error ? e.message : String(e) }); }
      finally { controller.close(); }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
}
```

Uses only universal Web APIs (no web/server-only imports) so it is legal in
`shared/`. Pattern proven by the current `handle-delete.ts:18-57`.

### New file 2 — `web/internal/read-ndjson.ts` (guarded client reader)

```ts
import { EndpointError } from "@plugins/infra/plugins/endpoints/web";
import { reportEndpointError } from "@plugins/infra/plugins/endpoints/web";
// async generator yielding one parsed frame object per line.
export async function* readNdjson(
  route: string, url: string, init?: RequestInit,
): AsyncGenerator<Record<string, unknown>> {
  const res = await fetch(url, init);
  if (!res.ok) {                                   // the bug fix: never JSON.parse a 502 body
    const body = await res.text().catch(() => null);
    reportEndpointError({ route, status: res.status, body });   // restores crash reporting
    throw new EndpointError(res.status, body ?? `HTTP ${res.status}`);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line) as Record<string, unknown>;
    }
  }
}
```

`reportEndpointError` is currently internal to `endpoints/web`; expose it from the
web barrel (it already lives in `error-reporter.ts`; just add the re-export) so
this reader gets the same crash reporting `fetchEndpoint` has. `EndpointError` is
already exported.

### Server changes — `server/internal/handle-list.ts`

- Convert from `implement(listWorktrees, …)` (JSON) to a raw `HttpHandler`
  returning `ndjsonResponse(async (emit) => { … })` — mirrors `handle-delete.ts`
  being a raw handler. Route wiring key stays `listWorktrees.route`.
- Inside the producer: keep the **`listDatabases()` batch** already applied (one
  catalog query, not 2082 `databaseExists`), build the task/db maps, then
  `pMap(attempts, 50, async a => emit({ item: await buildEntry(a) }))`, then
  `emit({ end: true })`. No server sort (rows stream in completion order).
- Extract the per-attempt entry computation into a `buildEntry(...)` helper so the
  producer reads at one altitude.

### Server changes — `server/internal/handle-delete.ts` (validate the dedup)

Migrate to `ndjsonResponse(async (emit) => { … })`: emit `{ step }` / `{ ok: true }`
/ `{ ok: false, error }` exactly as today; drop its hand-rolled `ReadableStream` +
encoder. Proves the helper has two consumers, not one.

### Endpoint def — `shared/endpoints.ts`

- `listWorktrees` stays a `defineEndpoint({ route })` **without** a `response`
  schema (it's streamed now — like `deleteWorktree`). Drop the response schema
  added earlier. Keep `WorktreeEntrySchema` / `WorktreeEntry` (server return type +
  client per-row validation). `bulkDeleteWorktrees` keeps its body+response schema.

### Client changes — `web/components/worktree-cleanup-panel.tsx`

- `load()` streams: `for await (const frame of readNdjson(listWorktrees.route, interpolatePath(listWorktrees.path, {}), { signal }))` →
  on `item` push `WorktreeEntrySchema.parse(frame.item)` into a local accumulator;
  on `end` mark complete; on `error` throw. **Batch renders** by `setEntries([...acc])`
  every ~50 rows + a final flush (≈25 renders for 1257 rows, no timer). After the
  loop, if not completed → throw (truncation guard). Sort createdAt-desc via
  `useMemo` over `entries` (was a server sort). Keep `listError` via
  `getEndpointErrorMessage`. An `AbortController` cancels the stream on
  unmount/reload.
- `deleteOne()` consumes `readNdjson(deleteWorktree.route, interpolatePath(deleteWorktree.path, { id }), { method: "DELETE" })`,
  interpreting `{ step }` / `{ ok }` frames — replacing its open-coded reader and
  inheriting the `res.ok` guard.
- `deleteSafe()` unchanged (`fetchEndpoint(bulkDeleteWorktrees, …)` — fast JSON).

## Critical files

- `plugins/debug/plugins/worktree-cleanup/shared/ndjson.ts` — **new** (server emitter)
- `plugins/debug/plugins/worktree-cleanup/web/internal/read-ndjson.ts` — **new** (guarded reader)
- `plugins/debug/plugins/worktree-cleanup/server/internal/handle-list.ts` — stream + keep N+1 fix
- `plugins/debug/plugins/worktree-cleanup/server/internal/handle-delete.ts` — use `ndjsonResponse`
- `plugins/debug/plugins/worktree-cleanup/shared/endpoints.ts` — drop list response schema
- `plugins/debug/plugins/worktree-cleanup/web/components/worktree-cleanup-panel.tsx` — stream + batch + sort
- `plugins/infra/plugins/endpoints/web/index.ts` — re-export `reportEndpointError`
- reference: `handle-delete.ts` (NDJSON pattern), `endpoints/web/internal/error-reporter.ts`

## Verification

1. `./equin build` — passes tsc + checks.
2. Stream completes with a terminal sentinel (no 502):
   ```
   bun -e 'const r=await fetch("http://att-1780583941-hrog.localhost:9000/api/debug/worktrees");
   console.log("status",r.status,r.headers.get("content-type"));
   const l=(await r.text()).trim().split("\n"); console.log("frames",l.length,"first",l[0]?.slice(0,80),"last",l.at(-1));'
   ```
   Expect `200 application/x-ndjson`, first `{"item":…}`, last `{"end":true}`. Time-to-first-byte « 10s even though total > 10s.
3. UI: `bun e2e/screenshot.mjs --url http://att-1780583941-hrog.localhost:9000/debug/worktree-cleanup --out /tmp/wt`
   — rows appear progressively; spinner tracks streaming; no error placeholder.
4. Error path still surfaces a clean message + fires a "Crash recorded" toast (reporting restored).
5. Regression: single delete (streamed steps) and `deleteSafe` bulk-delete still work.
