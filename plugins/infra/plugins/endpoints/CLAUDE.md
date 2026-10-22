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

Imperative calls go through a `FetchEndpoint` — the client bound to ONE transport (there is no transportless fetcher). Non-2xx responses throw `EndpointError(status, body)`.

## The fetcher is bound to a transport

```typescript
import { useFetchEndpoint, type FetchEndpoint } from "@plugins/infra/plugins/endpoints/web";

// A component or hook: the subtree's transport (a demo scope's, else the page's).
const fetchEndpoint = useFetchEndpoint();
await fetchEndpoint(updateAgent, { id }, { body: { name } });

// An exported helper takes it from its caller — never reaches for one itself.
export async function patchAgent(fetchEndpoint: FetchEndpoint, id: string, patch: Patch) { … }

// Page-level code sanctioned to name the page's server (telemetry, boot), under
// a `networking/no-page-transport` exemption in its own exempt/index.ts:
const fetchEndpoint = fetchEndpointOver(pageTransport);
```

- **Every binding is named `fetchEndpoint`.** The call-name lint rules
  (`no-void-fetch-endpoint`, `live/no-endpoint-read`,
  `page-editor/no-adhoc-structural-write`, `no-reactive-server-io`) recognise a
  call by that name; `endpoints/fetch-endpoint-binding-name` rejects a
  `useFetchEndpoint()` / `fetchEndpointOver(…)` result bound under another name
  (or called inline / returned), a `FetchEndpoint`-typed binding named
  otherwise, and an alias of one.
- **One fetcher per transport** (`transportScoped`), so its identity is stable
  across renders and safe in a deps array.
- **Tests** (`web/testing`): `fakeFetchEndpoint(answer?, { machine?, transport? })`
  records each call (`calls[].route / params / body`) and answers it;
  `fake.fetchEndpoint` is passed to a helper, `withTransport(fake)` is a
  `render` / `renderHook` wrapper under which `useFetchEndpoint`,
  `useEndpoint` and `useEndpointMutation` all answer from the fake. Never
  `vi.mock` the endpoints barrel to stub a call.

**Off the page — `callEndpoint`** (`endpoints/server`). Server, machine and CLI code calling one of our endpoints (central's secrets from a backend, a backend from the CLI or an MCP tool) uses `useFetchEndpoint`'s twin over the global `fetch` and an absolute origin (server-side only — a page reaches a server through its subtree's transport):

```typescript
import { callEndpoint } from "@plugins/infra/plugins/endpoints/server";
import { EndpointError } from "@plugins/infra/plugins/endpoints/core";

const { has } = await callEndpoint(secretsHas, {}, { origin: "http://localhost:9000", body: ref });
await callEndpoint(secretsSet, {}, { origin, body });          // void endpoint → void answer (204)
const s = await callEndpoint(queueHealthSummaryEndpoint, {}, { origin: namespaceUrl(ns) });
```

Params, body, query and the decoded answer come from the contract, so a contract change is a tsc error at the caller (the bug class: `secretsSet` went 204 while its caller still parsed `{ ok: true }`). No answer → fetch's `TypeError`; a non-2xx → `EndpointError` whose message names the request and the reply. Retry / offline policy is the caller's, over those two. Both clients share one fetch-free request core in `core/request.ts` (`endpointRequest` / `readEndpointResponse`), which a module that cannot import `server/` (a `shared/` helper run by a host process) composes around its own sanctioned `fetch`. A hand-written `/api/…` path or a `fetch` to an endpoint's `.path` off the page is the `endpoints/no-raw-endpoint-call` lint; a genuine exception (a hook process that must not load zod) is an inline disable with the reason. A URL handed to someone else rather than fetched (an agent's MCP URL) is built with `endpointPath(endpoint, params)`. A reply read across code generations (any worktree's backend, through the gateway) is not an exception: its contract defaults every field added since (`.default(…)`), so an older backend's reply parses — `profiling/runtime`'s schemas are the example.

**Endpoints are for writes, and for reads sanctioned to stay request/response.** A server read a surface renders is a live resource — a `liveValue` (`params`, a typed `query`, or cursor-`paged`) or a `liveCollection`, read with `useLive` (`plugins/network/plugins/live/CLAUDE.md`). The `live/no-endpoint-read` lint flags, in `web/` code, `useEndpoint`, `useEndpointResource`, TanStack's `useQuery` family, `fetchEndpoint` inside a `queryFn`, a GET `fetchEndpoint` / `readNdjson` that render, a hook or an effect runs, and `invalidateQueries` / `refetchQueries` over an endpoint read's key; imperative `fetchEndpoint` (a mutation, a handler) is untouched. The read hooks below remain for the existing sites — the rule's debt burndown (`./singularity exempt list --rule live/no-endpoint-read --debt`) — never for new code.

**A read that a surface renders is a `ResourceResult`, not React Query's own result** (whose `isPending` / `isError` let a surface read `data ?? []` without asking which state it is in). From `@plugins/primitives/plugins/live-state/web` (live-state sits downstream of endpoints, so the adapters live there):

- a GET — `useEndpointResource(endpoint, params, opts)` instead of `useEndpoint`;
- a structured question (once a POST body) is a typed-query `liveValue` (`{ query }`), and a paged read a collection's window or a key-range-paged one (`{ query, paged }`; a source with only forward cursors is one bounded value or a Postgres mirror — `network/live`, *Paged reads*) — never a TanStack query over `fetchEndpoint`. The revision-keyed and infinite query adapters are deleted; `useQueryResource` remains only for local async loads (a code-split module), never a server read.

An `EndpointError` maps to `not-found` on a 404 and `loader-failed` otherwise, with the server's message; a `fetch` that got no answer to `transport`; a response the schema rejects to `client-outdated`.

Data the **first render** needs (no loading flash) is not an endpoint read: declare it a `liveValue` with `preload: "boot"` / `"boot-and-keep"` (`network/live`), which the boot snapshot hydrates.

## Desktop-only endpoints — `needsMachine`

An endpoint whose handler needs the computer (it spawns, reads a checkout, talks to the host) is declared so, and every host without the computer — an in-browser server, the demo — answers it "not available" without a request. Design: `research/2026-10-18-global-portable-server-machine-split.md` §1c.

```typescript
// core/ — the feature names the sentence the client shows
export const launchTask = defineEndpoint({
  route: "POST /api/tasks/launch", body: …, response: …,
  needsMachine: { feature: "Launching an agent" },
});   // → MachineEndpointDef

// machine/internal/handle-launch-task.ts — never server/
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
export const handleLaunchTask = implementMachine(launchTask, async ({ body }) => …);
// machine/index.ts: { httpRoutes: { [launchTask.route]: handleLaunchTask } } satisfies MachinePluginDefinition

// web/ — the answer is a result; gate the control before the click
const availability = useMachineAvailability(launchTask);   // { available: true } | { available: false; message }
const fetchEndpoint = useFetchEndpoint();
const res = await fetchEndpoint(launchTask, {}, { body });
if (res.kind === "unavailable") …res.message; else …res.value;
const m = useEndpointMutation(launchTask);                  // { kind: "unavailable"; message } | { kind: "available" } & UseMutationResult
```

- **The chain, each link tsc's** (`MachineHttpHandler` / `PortableHttpHandler` in `server-core/core`):
  1. A handler that spawns cannot live in `server/` (the `boundaries/no-platform-api` lint).
  2. `implement` takes only a portable `EndpointDef` (whose `needsMachine` is `undefined`); `implementMachine` — exported only from the `machine` barrel — only a `MachineEndpointDef`, and brands its handler `MachineHttpHandler`.
  3. A `machine/` barrel's `httpRoutes` (`MachinePluginDefinition`) take only `MachineHttpHandler`s, and a `server/` barrel's (`ServerPluginDefinition`) refuse them — so a portable endpoint is never served by machine code alone (a silent 404 on every other host), and a machine one never by `server/`.
  4. Every client call site handles the unavailable arm: `fetchEndpoint` answers `MachineResult<T>` (`{ kind: "ok"; value } | { kind: "unavailable"; message }`), `useEndpoint` reads one, and `useEndpointMutation` is unavailable at the HOOK level, so `mutate` is unreachable without narrowing. Portable endpoints are unchanged.
- **Decided by the transport.** `Transport.machine` (`primitives/networking`) is required: `pageTransport` is `true`, `browserServerTransport` `false`. A subtree's transport is fixed, so the arm is stable across renders. Under `machine: false` nothing is sent.
- **One sentence** — `unavailableMessage(feature)` (core): "Launching an agent isn't available in this version of the app — it needs Singularity running on your computer."
- **`useMachineAvailability(declaration)`** takes any `{ needsMachine }` declaration — an endpoint or a live read (`network/live`) — for a control that renders disabled with the message (Welcome's send button, the launch form).
- **Residual gap:** an `await fetchEndpoint(machineDef, …)` whose value is never read ignores the arm silently. Prefer the hook form, or read the result.
- **A browser host serves the rest — proven at build.** The browser-host coverage guard (codegen's `core/browser-host-coverage.ts`, run by `deriveBrowserHostGraph`, so a gap fails `build` and `push`; nothing exempts it) requires every endpoint a host's scoped page calls — a declaration it imports, or a raw `/api/<prefix>` URL it builds — to be routed by a `server/` barrel of the host's graph, or declared `needsMachine`. Its reading of a declaration is `endpointExports` (`plugin-meta/parse-utils`): the `route:` must be one string literal. So a host's `409 { reason: "unsupported" }` refusal (`unsupportedEndpointResponse`) is a gap the guard missed: the fetcher throws and reports it like any other failure.

## Assets an element loads — `AssetPath` / `useAssetSrc`

An `<img>`, `<a href download>`, `<video>` or `<iframe>` loading a server file
(an attachment, a checkout image, a host file) never gets a bare `/api/…`
string: inside a demo scope that string reaches the page's server, not the
scope's. The builder returns an `AssetPath` and the element reads its `src`
from `useAssetSrc`.

```typescript
// core/ — built from the GET endpoint that serves it (path and needsMachine derived)
export const attachmentUrl = (id: string): AssetPath =>
  assetPath(getAttachmentFile, { id });                 // query, when the route has one: 3rd arg

// web/ — over the subtree's transport
const src = useAssetSrc(attachmentUrl(id));             // loading | ready{src} | unavailable{message} | error{message}
if (src.kind !== "ready") return <UnloadedAssetImage src={src} name={name} />;
return <img src={src.src} />;
```

- **Opaque on purpose.** `AssetPath` is not a string, so `src={attachmentUrl(id)}`
  is a tsc error — every sink resolves it — and it has no `path` field: the
  path sits under the `ASSET_PATH` symbol, read only by `useAssetSrc`.
  Persisting an address into a document (an attachment's markdown) spells it
  from the route itself (`interpolatePath(endpoint.path, params)`).
- **Decided by the transport.** `servesUrls` (the page's own server): `ready`
  with the path itself, synchronously. Otherwise (an in-browser server):
  fetched through `transport.fetch`, handed out as a blob URL shared by every
  element showing that path and revoked when the last unmounts (one store per
  transport, `transportScoped`). A route declared `needsMachine` on a transport
  without the computer: `unavailable`, nothing fetched.
- `useAssetSrcs(assets)` — the same for a set (a folder's images).
- Image sinks: `AssetThumbnail` / `UnloadedAssetImage`
  (`overlay/image-viewer`); file-viewer renderers: `UnloadedFile`.
- Persisted markdown holding an `/api/…` address (`![](/api/attachments/<id>)`)
  is converted to an asset by the conversation markdown's `img-enhancer`
  (`conversation-view/markdown-extensions`); everywhere else the base
  `<Markdown>` `img` / `a` (`primitives/markdown`) render such an address as
  text under a transport no URL reaches, so it never loads from the page.

## Main is read-only for agent sessions — `agentWrite`

On main's backend, `implement` / `implementMachine` refuse a write (any method
but GET / HEAD / OPTIONS) carrying the agent-origin headers (`originOf` from
`request-origin/core`) with `403 { reason: "agent-write-refused", route,
message }` — before the body is decoded. Decided once per route
(`agentWriteGate`, `core/agent-write.ts`, from `isMain()`), so other deploys pay
nothing. Design: `research/2026-10-22-global-main-read-only-for-agent-sessions.md`.

```typescript
export const emitLogs = defineEndpoint({
  route: "POST /api/logs/emit", body: …, response: …,
  agentWrite: "telemetry",          // or "agent-control" — a closed union
});
```

- **Absent = protected**, so a new endpoint is gated without anyone opting in.
  Declare `"telemetry"` only for a write of observability data, `"agent-control"`
  only for one acting on the agent session's own writes (the ledger revert). A GET
  declaring it is a tsc error.
- **No write route escapes it (tsc).** server-core's `HttpRoutes` — the type of
  every server / machine barrel's `httpRoutes` — takes only an
  `EndpointHttpHandler` on a POST / PUT / PATCH / DELETE key, a brand minted only
  here. A raw write handler (a stream, a binary body, custom headers) goes
  through `rawEndpointHandler(endpoint, handler)` (or `machineHandler(endpoint,
  handler)`), which runs the same gate and nothing else.
- **The client.** `fetchEndpoint` stamps `AGENT_WRITE_HEADER` on a request to a
  declaring endpoint (advisory — read only by the agent browser's write drain;
  the server reads the declaration) and turns the refusal into
  `EndpointAgentWriteRefusedError`, which files nothing: not to
  `endpointErrorSink`, not as an unhandled rejection (the crash collector skips
  it), not as an optimistic-rejection report (toasted only). The toast / error
  message is the server's sentence, pointing at `./singularity build`.
- **Not covered:** `central/` routes (one process for every worktree, never
  main's), and clients that do not send the agent headers (raw `curl`, page JS
  overriding them) — the gate prevents accidents, it is not a security boundary.

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

A `FetchEndpoint` call also accepts two transport opts for fire-and-forget beacons:

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
  `fetchWithRetry(...)` / `sendBeacon(...)` / `new XMLHttpRequest()` from any
  module a page can load (`web/`, and the `core/` / `shared/` helpers web
  imports) is forbidden — enforced by the `no-raw-web-fetch` lint rule and the
  `endpoints:typed-web-fetches` check. A module that runs outside any page (an
  agent's hook script) is exempted in its own manifest.
- **Off the page, endpoints are called with `callEndpoint`.** A hand-written
  `/api/…` path or a `fetch` built from an endpoint's `.path` in server /
  central / machine / cli / shared / core code is forbidden — enforced by the
  `no-raw-endpoint-call` lint rule.
- **No `void fetchEndpoint(...)` for user-triggered mutations.** A discarded
  endpoint promise lets a non-2xx response escape to `window.onunhandledrejection`
  (a contextless `browser-rejection` crash, never a toast) — enforced by the
  `no-void-fetch-endpoint` lint rule. Use `useEndpointMutation`. Genuine
  fire-and-forget (see below) opts out explicitly: a whole-file glob in
  `lint/index.ts` or an inline
  `// eslint-disable-next-line endpoints/no-void-fetch-endpoint -- <why>`.
- **JSON server responses must go through `implement()`.** A raw
  `Response.json()` in a server/machine/central handler is forbidden — enforced by
  `endpoints:no-raw-json-handlers`. Raw `new Response(...)` handlers remain
  allowed only for binary / stream / custom-status responses (where
  `implement()`'s 200/204 contract doesn't fit).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Typed endpoint contract primitive. useFetchEndpoint (a FetchEndpoint bound to the subtree's transport; fetchEndpointOver(t) for sanctioned page-level code), useEndpoint, and useEndpointMutation consume endpoint definitions on the client; useAssetSrc turns an AssetPath (a GET endpoint's asset) into what an element loads over the subtree's transport (the path, a blob URL, or unavailable). Typed endpoint contract primitive. defineEndpoint declares the contract; implement() creates the server handler; callEndpoint() calls one from off the page (a backend, the CLI) through its contract; useFetchEndpoint/useEndpoint consume on the client.
- Load-bearing: yes
- Web:
  - Uses:
    - `primitives/networking.fetchWithRetry`
    - `primitives/networking.FetchWithRetryOptions`
    - `primitives/networking.Transport`
    - `primitives/networking.transportScoped`
    - `primitives/networking.useTransport`
    - `primitives/networking.useTransportScoped`
  - Exports (types):
    - `AssetSrc`
    - `EndpointErrorInfo`
    - `FetchEndpoint`
  - Exports (values):
    - `EndpointAgentWriteRefusedError`
    - `EndpointError`
    - `endpointErrorSink`
    - `endpointQueryKey`
    - `fetchEndpointOver`
    - `getEndpointErrorMessage`
    - `useAssetSrc`
    - `useAssetSrcs`
    - `useEndpoint`
    - `useEndpointMutation`
    - `useFetchEndpoint`
    - `useMachineAvailability`
- Core:
  - Uses:
    - `infra/request-origin.AGENT_WRITE_HEADER`
    - `infra/request-origin.originOf`
    - `infra/runtime-identity.isMain`
    - `infra/runtime-profiler.chargeWait`
    - `infra/runtime-profiler.recordEntrySpan`
    - `packages/inflight.createInflight`
    - `packages/semaphore.createSemaphore`
  - Exports (types):
    - `AgentWrite`
    - `AssetPath`
    - `Codec`
    - `EndpointAnswer`
    - `EndpointDef`
    - `EndpointRequestOpts`
    - `ExtractParams`
    - `MachineAvailability`
    - `MachineEndpointDef`
    - `MachineFeature`
    - `MachineResult`
    - `MachineUnavailable`
  - Exports (values):
    - `agentWriteRefusedMessage`
    - `ASSET_PATH`
    - `assetPath`
    - `blob`
    - `dateString`
    - `defineEndpoint`
    - `EndpointAgentWriteRefusedError`
    - `EndpointError`
    - `endpointPath`
    - `endpointRequest`
    - `extractMethod`
    - `extractPath`
    - `getRouteSlowThresholdMs`
    - `HttpError`
    - `implement`
    - `interpolatePath`
    - `isAgentWriteRefusal`
    - `isCodec`
    - `multipart`
    - `rawEndpointHandler`
    - `readEndpointResponse`
    - `unavailableMessage`
    - `unmatchedApiResponse`
    - `unsupportedEndpointResponse`
- Cross-plugin:
  - Imported by: 222 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps` ×55
    - `conversations` ×32
    - `page` ×20
    - `debug` ×19
    - `infra` ×19
    - `tasks` ×17
    - `primitives` ×16
    - `build` ×8
    - `reports` ×6
    - `ui` ×6
    - `auth` ×5
    - `active-data` ×2
    - `code-explorer` ×2
    - `config_v2` ×2
    - `history` ×2
    - `integrations` ×2
    - `screenshot` ×2
    - `apps-core/app-usage`
    - `backup`
    - `database/fork`
    - `plugin-meta/plugin-health`
    - `release`
    - `search/engine`
    - `shell/notifications`
- Exemptions:
  - Exempts itself from:
    - `endpoints/no-raw-web-fetch` — `web` (sanctioned)
    - `live/no-endpoint-read` — `web` (sanctioned)
  - Exempted by:
    - `apps/pages/page-tree` (0 debt)
    - `apps/sonata/playback-history` (0 debt)
    - `apps/sonata/rich/key-mode` (0 debt)
    - `apps/sonata/rich/swing` (0 debt)
    - `apps/sonata/transpose` (0 debt)
    - `conversations/compaction-context` (0 debt)
    - `infra/endpoints` (0 debt)
    - `infra/mcp/browser` (0 debt)
    - `infra/ndjson-stream` (0 debt)
    - `primitives/live-state` (0 debt)
    - `primitives/networking` (0 debt)
    - `primitives/networking/page-transport` (0 debt)
    - `shell/notifications` (0 debt)
    - `tasks/task-graph` (0 debt)
- Server:
  - Exports (values):
    - `callEndpoint`
    - `HttpError`
    - `implement`
    - `rawEndpointHandler`
- Machine:
  - Exports (values):
    - `implementMachine`
    - `machineHandler`
- Test helpers:
  - Web: `@plugins/infra/plugins/endpoints/web/testing`
    - `fakeFetchEndpoint` — A fake `FetchEndpoint` that records each call and answers it with `answer` (default: `undefined`, a void response) — and a transport that hands it to every component under it.
    - `withTransport` — A `wrapper` (`render` / `renderHook`) mounting `target`'s transport above the tree — a fake's, so every endpoint client under it answers from the fake.
    - Types: `FakeEndpointAnswer`, `FakeFetchEndpoint`, `FakeFetchEndpointOptions`, `FetchEndpointCall`

<!-- AUTOGENERATED:END -->
