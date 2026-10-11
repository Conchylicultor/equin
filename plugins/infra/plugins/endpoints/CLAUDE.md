# endpoints

Typed HTTP endpoint contracts. Declare once in `core/`; derive server validation and the web client from that single definition — no duplicated URL strings, no manual `as` casts.

## Three-layer pattern

**1. Define** — `core/endpoints.ts` (importable from any runtime):

```typescript
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const getAgent = defineEndpoint({
  route: "GET /api/agents/:id",   // method + path in one string; :id inferred as params.id
  response: AgentSchema,
});

export const updateAgent = defineEndpoint({
  route: "PATCH /api/agents/:id",
  body: UpdateAgentBodySchema,    // validated on server, type-checked on client
  response: AgentSchema,
});
```

**2. Implement** — `server/internal/handle-*.ts`:

```typescript
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { getAgent } from "../../core/endpoints";

export const handleGet = implement(getAgent, async ({ params }) => {
  const row = await db.select()…where(eq(agents.id, params.id))…limit(1);
  if (!row) throw new HttpError(404, "Not found");
  return row;  // auto-wrapped in Response.json(); void → 204
});
```

Wire into `httpRoutes` via the computed key: `{ [getAgent.route]: handleGet }`.

**3. Consume** — web components:

```typescript
import { useEndpoint, useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";

// GET — wraps useQuery; params type-checked against route template
const { data } = useEndpoint(getAgent, { id });

// PATCH — wraps useMutation; invalidates listed queries on success
const { mutateAsync } = useEndpointMutation(updateAgent, { invalidates: [getAgent] });
await mutateAsync({ id }, { body: { name: "new" } });
```

Use `fetchEndpoint` for imperative fetches outside React. Non-2xx responses throw `EndpointError(status, body)`.

**Endpoints are for writes, and for reads sanctioned to stay request/response.** A server read a surface renders is a live resource — a `liveValue` (`params`, a typed `query`, or cursor-`paged`) or a `liveCollection`, read with `useLive` (`plugins/network/plugins/live/CLAUDE.md`). The `live/no-endpoint-read` lint flags, in `web/` code, `useEndpoint`, `useEndpointResource`, TanStack's `useQuery` family, and `fetchEndpoint` inside a `queryFn`; imperative `fetchEndpoint` (a mutation, a handler) is untouched. The read hooks below remain for the existing sites — the rule's debt burndown (`./singularity exempt list --rule live/no-endpoint-read --debt`) — never for new code.

**A read that a surface renders is a `ResourceResult`, not React Query's own result** (whose `isPending` / `isError` let a surface read `data ?? []` without asking which state it is in). From `@plugins/primitives/plugins/live-state/web` (live-state sits downstream of endpoints, so the adapters live there):

- a GET — `useEndpointResource(endpoint, params, opts)` instead of `useEndpoint`;
- a structured question (once a POST body) is a typed-query `liveValue` (`{ query }`), and a cursor-paged read a paged one (`{ query, paged }`) — never a TanStack query over `fetchEndpoint`. The revision-keyed and infinite query adapters are deleted; `useQueryResource` remains only for local async loads (a code-split module), never a server read.

An `EndpointError` maps to `not-found` on a 404 and `loader-failed` otherwise, with the server's message; a `fetch` that got no answer to `transport`; a response the schema rejects to `client-outdated`.

To make a GET available on the **first render** (no loading flash), seed it from a `Core.Boot` task with `hydrateEndpoint(endpoint, params, opts, data)` — exported from `@plugins/primitives/plugins/live-state/web` (live-state owns the app's default QueryClient and sits downstream of endpoints, so the import can only point that way). It writes the exact query key `useEndpoint` reads via the shared `endpointQueryKey` helper this plugin exports, so the two cannot drift. Canonical use: tweakcn's preset list (`plugins/ui/plugins/tweakcn/web/boot.ts`).

## Non-JSON payloads (codecs)

A bare Zod schema in `body:`/`response:` means **JSON** — that's the default and covers ~all endpoints. Binary and multipart payloads opt into the *same* `body:`/`response:` slot via a **codec** exported from `@plugins/infra/plugins/endpoints/core`:

```typescript
import { blob, multipart } from "@plugins/infra/plugins/endpoints/core";

export const createScreenshot = defineEndpoint({
  route: "POST /api/screenshot",
  body: blob("image/png"),                 // raw binary request; sets Content-Type
  response: z.object({ id: z.string() }),  // bare schema → JSON response
});

export const getScreenshot = defineEndpoint({
  route: "GET /api/screenshot/:id",
  response: blob(),                        // typed Blob response (client decodes via res.blob())
});

export const uploadAttachment = defineEndpoint({
  route: "POST /api/attachments",
  body: multipart(),                       // FormData upload; the browser sets the boundary
  response: UploadedAttachmentSchema,
});
```

- `blob(contentType?)` — raw binary on the request (`body:`) or response (`response:`) side. The client encodes/decodes via `Blob`. A server handler that needs custom response headers (e.g. `cache-control`, `content-disposition`) may stay a raw handler instead of using `implement()` — `blob()` carries only the body.
- `multipart()` — **request-only** FormData. No `Content-Type` is set so the browser supplies the multipart boundary; using it in a `response:` slot throws.

`fetchEndpoint` also accepts two transport opts for fire-and-forget beacons:

```typescript
void fetchEndpoint(submitReport, {}, { body, keepalive: true, report: false });
```

- `keepalive: true` — RequestInit passthrough so the request survives page unload (crash/analytics beacons).
- `report: false` — skips endpoint error reporting for that call. Required for the crash beacon so a failing report can't recurse back into the crash pipeline. Defaults to `true`.
- `retry: { retries, backoffMs, retryOn? }` — opt-in: sends through `fetchWithRetry` (networking primitive), retrying a network error or a 502/503/504 — what a backend restart answers — with exponential backoff; a 4xx is never retried, and the last attempt's response goes through the normal non-2xx handling. Off by default: a retried request can land twice, so use it only for an idempotent call or one the server dedupes (the report beacon — reports dedupe by fingerprint).

## Global error handling

Every `useEndpointMutation` call is covered by a global toast safety net in `shell/toaster`. If a mutation errors and the error is unhandled, `getEndpointErrorMessage` extracts a human-readable string (prefers `body.message` over `"HTTP <status>"`) and `toast.error` fires automatically.

**Default: provide `onError` → global toast is silenced automatically.**

```typescript
// No onError — global toast fires on error (zero boilerplate)
useEndpointMutation(deleteTask);

// onError provided — toast suppressed; only the local handler runs
useEndpointMutation(deleteTask, {
  onError: (err) => setFormError(err.message),
});

// Show error inline via mutation.error — suppress without a local handler
useEndpointMutation(deleteTask, { meta: { suppressError: true } });

// Run a local side-effect AND still show the global toast (e.g. analytics)
useEndpointMutation(deleteTask, {
  onError: (err) => analytics.track(err),
  meta: { suppressError: false },
});
```

The `meta.suppressError` flag is also available on raw `useMutation` calls for non-endpoint mutations.

## `useEndpointMutation` vs `void fetchEndpoint()`

**Default: `useEndpointMutation` for all user-triggered mutations.** It gives you loading state, cache invalidation, and global error surfacing for free.

**`void fetchEndpoint()` only for genuine fire-and-forget** — background side-effects where two conditions hold simultaneously:
1. A failure is silent and self-correcting (the user can recover without knowing it happened).
2. State refreshes via another channel — a live-state WS push or the next user interaction — so no manual `invalidates` is needed.

Canonical examples: DnD rank writes (drag again to fix), notification dismissal (reappears on next load).

**Never reach for `void fetchEndpoint()` to skip error handling lazily.** If you want to suppress the toast without a local handler, use `meta: { suppressError: true }` on `useEndpointMutation` instead. `void fetchEndpoint()` bypasses the global handler entirely; the promise rejection still surfaces via the global `unhandledrejection` handler but is otherwise invisible to the user.

```typescript
// ✓ Fire-and-forget: rank update during DnD — silent failure is acceptable,
//   live-state WS push will correct the view on next event
void fetchEndpoint(updateRank, { id }, { body: { rank } });

// ✗ Wrong: delete is user-triggered; failure should surface via toast
void fetchEndpoint(deleteTask, { id });

// ✓ Right: use useEndpointMutation so global error handler fires
const { mutateAsync } = useEndpointMutation(deleteTask);
await mutateAsync({ id });

// ✓ Right: suppress the toast explicitly when you handle errors inline
const { mutateAsync } = useEndpointMutation(deleteTask, { meta: { suppressError: true } });
```

## Enforced invariants

- **Web code must use `fetchEndpoint`/`useEndpoint`.** Raw `fetch(...)` /
  `fetchWithRetry(...)` to `/api/...` from web code is forbidden — enforced by
  the `no-raw-web-fetch` lint rule and the `endpoints:typed-web-fetches` check.
- **No `void fetchEndpoint(...)` for user-triggered mutations.** A discarded
  endpoint promise lets a non-2xx response escape to `window.onunhandledrejection`
  (a contextless `browser-rejection` crash, never a toast) — enforced by the
  `no-void-fetch-endpoint` lint rule. Use `useEndpointMutation`. Genuine
  fire-and-forget (see below) opts out explicitly: a whole-file glob in
  `lint/index.ts` or an inline
  `// eslint-disable-next-line endpoints/no-void-fetch-endpoint -- <why>`.
- **JSON server responses must go through `implement()`.** A raw
  `Response.json()` in a server/central handler is forbidden — enforced by
  `endpoints:no-raw-json-handlers`. Raw `new Response(...)` handlers remain
  allowed only for binary / stream / custom-status responses (where
  `implement()`'s 200/204 contract doesn't fit).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Typed endpoint contract primitive. fetchEndpoint, useEndpoint, and useEndpointMutation consume endpoint definitions on the client. Typed endpoint contract primitive. defineEndpoint declares the contract; implement() creates the server handler; fetchEndpoint/useEndpoint consume on the client.
- Load-bearing: yes
- Web:
  - Uses:
    - `primitives/networking.fetchWithRetry`
    - `primitives/networking.FetchWithRetryOptions`
  - Exports (types): `EndpointErrorInfo`
  - Exports (values):
    - `EndpointError`
    - `endpointErrorSink`
    - `endpointQueryKey`
    - `fetchEndpoint`
    - `getEndpointErrorMessage`
    - `useEndpoint`
    - `useEndpointMutation`
- Core:
  - Uses:
    - `infra/runtime-profiler.chargeWait`
    - `infra/runtime-profiler.recordEntrySpan`
    - `packages/inflight.createInflight`
    - `packages/semaphore.createSemaphore`
  - Exports (types):
    - `Codec`
    - `EndpointDef`
    - `ExtractParams`
  - Exports (values):
    - `blob`
    - `dateString`
    - `defineEndpoint`
    - `extractMethod`
    - `extractPath`
    - `getRouteSlowThresholdMs`
    - `HttpError`
    - `implement`
    - `interpolatePath`
    - `isCodec`
    - `multipart`
- Cross-plugin:
  - Imported by: 227 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×59
    - `conversations` ×26
    - `debug` ×26
    - `infra` ×17
    - `tasks` ×17
    - `page` ×14
    - `primitives` ×12
    - `build` ×9
    - `ui` ×6
    - `auth` ×5
    - `code-explorer` ×4
    - `plugin-meta` ×4
    - `stats` ×4
    - `active-data` ×3
    - `apps-core` ×3
    - `reports` ×3
    - `config_v2` ×2
    - `history` ×2
    - `integrations` ×2
    - `review` ×2
    - `search` ×2
    - `backup`
    - `database/fork`
    - `release`
    - `screenshot`
    - `shell/notifications`
- Exemptions:
  - Exempts itself from:
    - `endpoints/no-raw-web-fetch` — `web` (sanctioned)
    - `live/no-endpoint-read` — `web` (sanctioned)
  - Exempted by:
    - `apps/pages/page-tree` (0 debt)
    - `apps/sonata/playback-history` (0 debt)
    - `apps/sonata/rich/key-mode` (0 debt)
    - `apps/sonata/transpose` (0 debt)
    - `infra/endpoints` (0 debt)
    - `infra/ndjson-stream` (0 debt)
    - `primitives/live-state` (0 debt)
    - `primitives/networking` (0 debt)
    - `shell/notifications` (0 debt)
    - `tasks/task-graph` (0 debt)
- Server:
  - Exports (values):
    - `HttpError`
    - `implement`

<!-- AUTOGENERATED:END -->
