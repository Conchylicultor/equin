# A browser read of server data outside `useLive` has no spelling

Task: `task-1793022098-hjniry`. Track: Mental model → Network Layer → Resources (`block-f64cfc08-…`), item [9]'s last box. Parent: `research/2026-10-11-global-endpoint-reads-onto-live.md` (Result / Review fixes (B10b), "Open").

## Context

The endpoint-reads migration (`task-1791560308-woqgfi`, on main `e898c14b6a`) is meant to leave one model in place: the browser **reads** server data only through live values (`useLive`) and **writes** only through typed endpoints (`fetchEndpoint` / `useEndpointMutation`). What enforces that model today is weaker than the model:

1. `live/no-endpoint-read` decides that a call is a read by its **method**, and only when it runs from render, a hook or an effect. So it misses a POST used as a read (chord `findLoops`, in an effect) and a GET from an event handler. Today there are **18 browser GET sites**: link-meta, host-fs, task launch, the Sonata hydrates, and others.
2. Raw `fetch` / XHR / `sendBeacon` to `/api` is caught only by name/regex rules (`endpoints/no-raw-web-fetch`, `endpoints:typed-web-fetches`). An alias, `.call`, a variable URL or a library defeats them.
3. "No debt for `live/no-endpoint-read`" is a doc line, because the exempt framework has no sanctioned-only option.

Decisions settled with the user:
- No self-declared `kind: read|write`.
- A browser `fetchEndpoint` of a GET is a **type error**.
- GET contracts stay for the CLI, e2e, servers and asset URLs.
- Event-handler reads use one new imperative reader of live values (`useLiveReader`). It is the single recorded exception to `network/live`'s "no new read hook" Design rule.
- A runtime request guard is **in this task**.
- Task launch builds its prompt **server-side**.

**Done means:**
- A browser `fetchEndpoint` / `useEndpointMutation` / `readNdjson` of a GET does not compile, and throws if forced by a cast.
- Every current browser read, POST reads included, is on `useLive` or `useLiveReader`.
- An unsanctioned same-origin `/api` | `/ws` | `/gateway` request from the page fails loudly at runtime.
- `live/no-endpoint-read`, `endpoints/no-raw-web-fetch` and `networking/no-page-transport` refuse debt entries (a tsc error plus a check).

## Design

### 1. Type ban: a derived `read` marker on every endpoint contract (rung 2)

The marker is **derived from the route by `defineEndpoint`**, not declared, so it adds no new claim.

```ts
// endpoints/core
type WriteMethod = "POST" | "PUT" | "PATCH" | "DELETE";
export type ReadMarker =
  "GET is a read: declare it live (liveValue / liveCollection) and read it with useLive (useLiveReader in an event handler); fetchEndpoint / useEndpointMutation send writes only";
type ReadOf<Route extends string> =
  [Route] extends [`${WriteMethod} ${string}`] ? undefined : ReadMarker; // allow-list: a wide string or a GET|POST union fails closed
// EndpointContract gains   readonly read: ReadOf<Route>;   defineEndpoint sets it from extractMethod
export type WriteEndpoint = { readonly read: undefined };
```

- **`FetchEndpoint`** (both overloads), **`useEndpointMutation`** (every overload plus its implementation) and **`readNdjson`** take `… & WriteEndpoint`. `readNdjson` stops taking a raw route string and takes an endpoint def; its one caller is `deleteWorktree`.
  - The tsc error reads out the `ReadMarker` sentence.
  - A generic wrapper constrained with `& WriteEndpoint` still compiles. A conditional type on `Route` would not.
  - This was verified on stand-in types with tsc 6.0.3.
- **Runtime check.** The first line of `call()` in `endpoints/web/internal/fetch-endpoint.ts` throws `` `${route}: ${read}` `` when `read` is set, which catches casts. `web/testing/fake-fetch-endpoint.ts` mirrors it.
- **Unaffected:** `assetPath` / `useAssetSrc` / `useAssetUrl`, `callEndpoint` (CLI, servers, MCP), `implement`, `endpointRequest`, and the e2e `agent-writes.ts`.
- All 377 routes are literals (the source parser already rejects a non-literal one), and no web code is generic over `EndpointDef` outside the endpoints plugin.

### 2. `useLiveReader`: the event-shaped read of a live value (`network/live/web`)

```ts
export function useLiveReader(): LiveReader; // the scope's NotificationsClient + useTransport()
interface LiveReader {
  (v: LiveValue<T, never, …, C, NM>): Promise<LiveAnswer<T, C, NM>>;
  (v: LiveValue<T, P, …, C, NM>, params: Record<P, string>): Promise<LiveAnswer<T, C, NM>>;
  (v: LiveQueryValue<T, Q, QIn, …, C, NM>, query: QIn): Promise<LiveAnswer<T, C, NM>>;
  // tsc-rejected: paged values, collections, null / many-tuple params
}
type LiveAnswer<T, C, NM> =
  | { status: "ready"; data: T }
  | { status: "refused"; code: C; message: string }
  | (NM extends MachineFeature ? { status: "unavailable"; message: string } : never);
```

**Behaviour:**
- **Failures throw a `ResourceError`.** These are network, `loader-failed` and `contract-mismatch`, the last including an undeclared refusal code. Each is reported once through live's sink.
- **Machine-only values.** `needsMachine` on a transport without a machine resolves `unavailable` with no request.
- **One tuple.** It goes through `canonicalParams` / `canonicalJson`, so the cache key is identical to `useLive`'s.
- **Cache semantics (no options).**
  - If the tuple is observed, it returns the pushed value with no request.
  - Otherwise it makes one HTTP read of `/api/(central-)resources/:key`, deduped through `packages/inflight`.
  - It **never seeds the cache** for an unobserved tuple.
  - A `load: "snapshot"` value always reads.
- **Where it is built.** It is `NotificationsClient.readOnce(…)` beside `fetchOverHttp` (`primitives/live-state/web/notifications-client.ts:~1528`), sharing its fetch, parse and refusal decoding (`resource-http-errors.ts`).

**Lint and docs:**
- `live/no-endpoint-read` gains an arm that flags a `LiveReader` call in a render, hook or effect, using the rule's existing read-context classifier.
- The Design rule in `network/live/CLAUDE.md` is reworded: `useLiveReader` is the one read function beside `useLive`, for a question an event asks and its own `await` consumes. It reads the same declarations, adds no declaration surface, and is banned wherever `useLive` fits.
- The doc records the reason: `useLive` would rebuild the `await` as pending state plus an acting effect.

### 3. Migrate every browser read outside live

| Site | Today | Becomes |
|---|---|---|
| url-paste `mention` (`page/plugins/url-paste/web/components/url-paste-plugin.tsx:~354`) | GET `linkMetaEndpoint` | `useLiveReader` over a new `bookmark.link-meta {url}`: `needsMachine: LINK_FETCH`, external, on-demand, refusals `blocked` / `unreachable`. It is not `bookmark.link-preview`, which caches images as attachments. The endpoint is deleted. |
| path-bar `complete` (`file-explorer/plugins/browser/web/internal/host-path-source.ts:86`, called from an effect in `path-bar.tsx:163`) | GET `hostFsComplete` | **`useLive`** over a new `host-fs.complete {prefix}`: `needsMachine`, `cappedList` plus `truncated`, and the missing / not-a-dir / denied cases. `PathBarSource.complete` becomes a `Hook` value (`framework/hook-value`), and `suggestions` becomes derived. |
| path-bar `validate` (`host-path-source.ts:111`) | GET `hostFsStat` | `useLiveReader` over the existing `host-fs.stat` (`infra/host-fs/core/internal/live.ts:170`), whose refusals map 1:1 onto today's result kinds. |
| favorites pin (`file-explorer/plugins/places/web/internal/favorites.ts:151`) | GET `hostFsStat` | The drag payload (`host-fs/core/internal/drag.ts:11`) carries `{path, kind}`, so no read is needed. If an external drop source needs one, it falls back to `useLiveReader(host-fs.stat)`. The `hostFsStat` endpoint is deleted. |
| task launch ×2 (`task-description.tsx:46`, `launch-agent-action.tsx:13`) | GET `getTask` | **No browser read.** The `createConversation` body gains an explicit "prompt from task" form, resolved server-side by `resolveLaunchPrompt` (`conversations/server/internal/launch-prompt.ts:12`) after the description flush commits. This also deletes the bare catch and the absorbed-failure fallback. `getTask` stays for the CLI and servers. |
| delete composition (`build/plugins/serve-composition/web/internal/use-delete-composition.tsx:82`) | GET `ownedNamespacesEndpoint` | `useLiveReader` over a new `build.serve-owned {composition}`, shaped like `serveStatus` (`serve-composition/shared/serve-status.ts:20`). The `Button` auto-pend keeps its await. The endpoint is deleted. |
| emit `status()` (`debug/plugins/live-state-churn/plugins/emit/web/internal/global-api.ts:23`) | GET `getEmitStatus` | Deleted: nothing calls it, and `live-state-emit.status` exists. |
| Sonata hydrates ×8 (`sources/plugins/{chord-grid,musicxml,midi,ultimate-guitar}/web/hydrate.ts`, `transcription/web/hydrate.ts`), called from the `panes.tsx:243` effect and `use-playback.ts:43` | GET `getSong*` + `getAttachmentFile` via `SourceContext.fetchEndpoint` | **`useLive`** (see below). The `getSong*` GETs are deleted if nothing outside the browser calls them. |
| boot-snapshot (`infra/boot-snapshot/web/internal/boot.ts:27`) | GET `fetchEndpointOver(pageTransport)` | A substrate read of live itself: `readEndpointResponse(def, await pageTransport.fetch(path))`, kept on the contract decode. Sanctioned `no-raw-web-fetch` exemption. |
| health probe (`infra/health/web/internal/client.ts:13`, wedge-watchdog) | GET `getHealth` | It must work while the live socket is wedged, so it uses the same sanctioned raw `transport.fetch` + `readEndpointResponse` form. |
| chord `findLoops` (`apps/chord/plugins/trainer/web/internal/use-loop-queue.ts:279`) | **POST read** in an effect | **`useLive`** over a typed-query `chord.loops`. See below. |
| UG import by URL (`ultimate-guitar/web/components/ug-import-dialog.tsx:170`, `web/loader.tsx:98`) | **POST read** `fetchUgTab` | `useLiveReader` over a new `sonata.ultimate-guitar.tab {url}`: external, `{fixed}`, with UG's classified errors as refusals. This is the sibling of `ugSearch` (`ultimate-guitar/shared/resources.ts:33`). The endpoint is deleted. |
| rewind preview (`conversation-view/plugins/rewind/web/hooks/use-go-back.tsx:85`) | **POST read** `previewRewindEndpoint` | `useLiveReader` over a new `conversations.rewind-preview {id, uuid}`, served from `machine/` with `needsMachine` and `load: "snapshot"`. Today's `ok:false` cases become refusals. The endpoint is deleted. |
| mail `cid:` images (`mail/plugins/reading-pane/web/internal/use-resolve-cid.ts`) | **POST read** `mailAttachmentDownloadEndpoint` → `setResolved` | Fire-and-forget materialise (a real write: it stamps `storedAttachmentId`). The URL is read from the live mail row, which already carries `storedAttachmentId`, and the `setResolved` state is deleted. The click path stays a write. |

**Sonata.**
- `Library.Source.hydrate` (`sonata/plugins/library/web/slots.ts:66,94`) becomes `useHydration: Hook<(songId: string | null) => ResourceResult<SourceHydration>>`.
- New lookup-only collections by `songId` cover chord-grid, musicxml, midi, the UG tab and transcription. `ugAlignmentRows` already exists.
- Attachment bytes become a `bytes: true` live value, immutable by id.
- The library renders one `<SourceHydrator>` per contribution and folds them in `useSongHydration(songId | null)`.
- `togglePlaySong` sets `pendingPlay`, and a host plays the song when it is ready (the icons pattern).
- The "already loaded" guard (`panes.tsx:224`) keeps a live change from resetting a playing session.
- `SourceContext` keeps only the `createOption.onSelect` writes.

**Chord `findLoops`.**
- `liveValue("chord.loops", { query: FindLoopsQuerySchema + round, schema: not-ready | ready{ candidates: cappedList(LoopCandidate, 50) }, refusals: ["invalid-query"], load: "on-demand" })` goes in `song-index/core/resources.ts`.
- It is served as `source: "external", changes: { fixed: { reason: "a random sample of loop windows; a new round is a new question" } }` over `findLoopWindows` (`server/internal/find.ts:211`). The lazy video-status fill in `ensureVideoStatus` is an idempotent cache.
- `excludeSectionIds` is capped.
- **The queue.** Each refill freezes `request = { round, queries }` in state when `wantsMore` turns true, then reads `useLive(chordLoops, request?.queries ?? null)` (many tuples). It folds the ready answers into the pool and clears `request`. This replaces the `inFlight` ref and the effect's `fetchEndpoint`.
- `findLoopsEndpoint` and `handleFindLoops` are deleted. `nextChords` and `countLoopsInSet` stay as POST contracts, because they have e2e callers only.

### 4. `live/no-endpoint-read` after the ban (rung 3)

- **Kept:** the TanStack-read arm.
- **Dropped:** the GET-`fetchEndpoint` and `readNdjson` arms, because tsc now holds them.
- **Added — any method, answer used:** a `fetchEndpoint` / `mutateAsync` of any method in read context (render, hook body, effect, module top level) whose answer is used, meaning not `void`-ed or discarded. A scripted scan finds only `findLoops` today, which is migrated, so the expected count is 0–1 sanctioned entries. `recordPlay` (`void`), `ensureChordIndex` (`mutate`, answer unused) and `emitLogs` (reached from a timer) pass.
- **Added — `LiveReader` in read context** (§2).
- **Residual, recorded rather than closed:** a POST read issued from an event handler. Nothing static tells "click → POST read → show" from "click → POST write → show result". It is held by review. The `ReadMarker` message, together with `useLiveReader`, makes the honest spelling as short as the lie. A server-side witness ("a non-GET that never wrote") was weighed and rejected: it can only report, and it is noisy, since in-memory writes, idempotent ensures and cache hits all write nothing.

### 5. Page request guard (rung 4)

- **Where it lives.** A new dependency-free leaf plugin, `primitives/networking/plugins/request-guard` (web). It is installed by a side-effect file imported **first** in `framework/web-core/web/main.tsx` (`import "./install-request-guard";`). A call in `main.tsx`'s body would run after `App`'s whole import graph had evaluated. We checked that nothing requests `/api` earlier: `index.html`'s inline scripts and the composed `/artifacts` links don't.
- **What it guards.** It wraps `fetch` (string, URL or `Request`, resolved against `document.baseURI`), `XMLHttpRequest.prototype.open`, `navigator.sendBeacon`, `EventSource`, and `WebSocket`, for same-origin `/api/*`, `/ws/*` and `/gateway/*`.
- **Sanctioned channels hold a capability, not a mark.**
  - The guard exports `nativeFetch` / `NativeWebSocket`. They fall back to the global at call time when no guard is installed, so jsdom stubs keep working.
  - `pageTransport.fetch` (`networking/plugins/page-transport/web/page-transport.ts:16`) and `use-reconnecting-ws.ts:67` use them. The live socket opens in the SharedWorker realm, which the page guard doesn't touch.
  - A lint, of the same kind as `networking/no-page-transport`, bounds who may import them.
- **Assets.** GET and HEAD are allowed on asset routes: the `ASSET_MIRROR_PREFIX`, which covers frimousse and smplr's `assetMirrorUrl` (`sonata/…/soundfont/web/voices.ts:100`, `piano/web/voices.ts:96`), plus the prefixes `assetUrlOver` hands out. Element loads (`img`, `iframe`, `new Image()`) aren't fetch, and stay allowed.
- **How it fails.**
  - `fetch` returns a rejected `RawApiRequestError`. XHR, `sendBeacon` and the constructors throw.
  - Every violation also goes to `reportError` + `console.error`, because frimousse swallows its HEAD rejection.
  - Violations raised before `crash-collector` mounts are held and replayed to it.
  - The message points agents at `query_db` and Playwright's `page.request`.
- **Moved first.**
  - `probeUrlStatus(transport, url)` (`networking/web/probe-url-status.ts:17`; caller `image-viewer/web/internal/use-image-load.ts:48`; its test gets `transportWrapper(testTransport())`).
  - About 22 e2e scripts with an in-page `fetch("/api/…")` (`page/plugins/{container,annotations,editor,quote,callout,url-paste,inline-page-link,formatting/link}/e2e/*`, `shell/toast/e2e/dismiss-all-verify.ts`, `text-editor/caret-trigger/e2e/caret-trigger-wedge.ts`) move onto a harness helper over `page.request`, in `e2e-harness/e2e`.
- **Deleted:** the unused `ReconnectingEventSource` (`networking/web/reconnecting-event-source.ts`).
- **Known ways past it, recorded:** same-origin iframes (`contentWindow.fetch`), `window.open`, and blob workers.

### 6. Sanctioned-only rules: `noDebt` (rungs 2 + 3)

- **Declaring it.** `LintContribution.noDebt?: string[]`, next to `closed` (`tooling/lint/core/build-lint-config.ts:~150`). It is validated like `closed`: a typo naming no rule of the barrel fails, and so does being in both `closed` and `noDebt`. `lintRuleIds` returns `noDebt`.
- **Check refusal.** `ruleIdProblems` (`tooling/exempt/core/load.ts:97`) refuses a `debt` entry for a `noDebt` rule, with the message "…declares it sanctioned-only…". `exempt:manifests-valid` (`exempt/check/index.ts:92`) passes the whole id set.
- **Type error.** `exempt-rule-ids-gen.ts` also emits `DebtableRuleId`: exemptable minus `noDebt`, filtered like `closed` at `:46-53`. `DebtExemption.rule` narrows to it, so a debt entry is a tsc error in the manifest.
- **Applied to:** `live/no-endpoint-read`, `endpoints/no-raw-web-fetch` and `networking/no-page-transport`.
- **Retired:** `endpoints:typed-web-fetches`. It is strictly weaker than the lint rule plus the guard.
- **Docs:** `exempt/CLAUDE.md`, `tooling/lint/CLAUDE.md`, and `network/live/CLAUDE.md`'s "held by review, not a check" line.

## Batches (one session, in order)

1. **noDebt** (§6), and the `read` marker + type ban (§1) behind a temporary compile list. `./equin check type-check` enumerates every site the ban breaks, which confirms the 18.
2. **`useLiveReader`** with tests (§2).
3. **Migrations** (§3). Order: simple deletes and the server-built task prompt; then link-meta, host-fs, serve-owned, rewind and UG tab (reader); then `findLoops`; then the mail `cid:` images; then Sonata (the largest).
4. **The lint rework** (§4).
5. **The guard** (§5): the e2e `page.request` helper and migration, then `probeUrlStatus`, then the guard and its `main.tsx` install.
6. **Docs:** endpoints, live, networking, exempt and the root `CLAUDE.md` read/write line; this doc's Result; and the track header.

If the session runs long, the cut line is after batch 4. Batch 5 is then filed as the next main task.

## Critical files

- `plugins/infra/plugins/endpoints/core/define-endpoint.ts`, `web/internal/{fetch-endpoint,use-endpoint-mutation}.ts`, `web/testing/fake-fetch-endpoint.ts`
- `plugins/infra/plugins/ndjson-stream/web/internal/read-ndjson.ts`
- `plugins/network/plugins/live/web/` (new `use-live-reader.ts`), `lint/no-endpoint-read.ts`, `CLAUDE.md`
- `plugins/primitives/plugins/live-state/web/notifications-client.ts`
- `plugins/framework/plugins/tooling/plugins/{exempt/core/{load,types}.ts, lint/core/build-lint-config.ts, codegen/core/exempt-rule-ids-gen.ts}`
- `plugins/primitives/plugins/networking/{plugins/page-transport,plugins/request-guard (new),web/probe-url-status.ts}`, `plugins/framework/plugins/web-core/web/main.tsx`
- The site files in §3

## Verification

- **Type ban.** A scratch web file with `fetchEndpoint(getHealth, …)` fails `./equin check type-check` with the `ReadMarker` sentence, and a cast throws at runtime (`fetch-endpoint.test.ts`). A `noDebt` debt entry fails both tsc and `exempt:manifests-valid` (`exempt.test.ts`).
- **Tests.**
  - `./equin test` on `network/live` (reader suite: observed join, unobserved no-seed, snapshot, refusal typing, `unavailable`, browser-server transport, dedupe, same key as `useLive`).
  - `infra/endpoints`, `tooling/exempt`, `networking` (guard: blocked fetch, XHR, beacon and EventSource; native capability passes; asset GET/HEAD allowed; pre-mount replay).
  - The `no-endpoint-read` cases.
  - `chord/trainer`, `sonata/library`, `file-explorer`.
- **Exemptions.** `./equin exempt list --rule live/no-endpoint-read --debt` → 0, and the same for the other two rules.
- **Live, on `./equin build` with the agent browser:**
  - Paste a URL into a page: the title fills.
  - File explorer: typeahead and validate; drag to pin.
  - Studio: delete a composition (the confirm path).
  - Rewind preview dialog.
  - UG import-by-URL and the loader.
  - Chord trainer: the queue refills repeatedly with no repeats, and not-ready / exhausted still show.
  - Sonata: play songs of each source kind (chord-grid, MusicXML, MIDI, UG, transcription), and a live source change while playing doesn't reset it.
  - Mail: an inline `cid:` image.
  - Task Launch from the detail pane and from the row action: the prompt carries the description.
  - `/api/resources/_debug` lists the new keys with their freshness.
- **Guard.** In the agent browser, `browser_javascript` with `fetch('/api/health')` rejects with `RawApiRequestError` and lands in Reports. The app boots with no violation. The emoji picker and the piano samples load. The migrated e2e scripts pass.

## Result

Landed in one session: nine parallel agents (noDebt, type ban, reader, four migration groups, lint, guard), then one integration pass. Build **green with checks**: `build-1793037665-mp6t2y`. About 315 files changed.

### What landed, per section

- **§1 Type ban.** `defineEndpoint` derives `read: ReadOf<Route>`. Only POST/PUT/PATCH/DELETE count as writes; HEAD/OPTIONS are reads. `FetchEndpoint` (both overloads), `useEndpointMutation` (every overload) and `readNdjson` take `& WriteEndpoint`. `readNdjson` now takes an endpoint def, and its one caller (`deleteWorktree`) sends the def. `call()` and the fake fetch throw `` `${route}: ${read}` `` on a cast. A route typed as plain `string` carries `ReadMarker | undefined`, so a specific def still fits `EndpointDef<string, …>` (`implement`, `callEndpoint`, registries); the write clients still refuse it.
- **§2 `useLiveReader`.** `NotificationsClient.readOnce` sits beside `fetchOverHttp`, sharing its URL, build header, refusal decoding and body read. `network/live/web` exports `useLiveReader` / `LiveReader` / `LiveAnswer`. The Design rule in `network/live/CLAUDE.md` records the reason. 13 tests.
- **§3 Migrations.** Every site in the table is migrated:
  - **Moved to live values:**
    - `bookmark.link-meta`
    - `host-fs.complete`, read through `useLive`; `PathBarSource.useComplete` is a Hook
    - `host-fs.stat`, read through the reader
    - `build.serve-owned`
    - `conversations.rewind-preview`
    - `sonata.ultimate-guitar.tab`
    - `chord.loops`, a typed query with a `round` nonce, read as one list
    - `attachments.bytes`, `bytes: true` and immutable
    - the lookup-only `sonata.midi`, `sonata.musicxml` and `sonata.ultimate-guitar.songs`
  - **Favorites** reads nothing: the drag payload now carries `{ path, kind }`.
  - **Task launch** sends `prompt: { from: "task" }`, built on the server.
  - **Boot snapshot and health probe** use `pageTransport.fetch` + `readEndpointResponse`, as sanctioned exemptions.
  - **Emit `status()`** is deleted.
  - **Mail `cid:`** images take their URL from the live row; the fetch is a fire-and-forget `materialise`.
  - **Deleted endpoints:** `linkMetaEndpoint`, `hostFsComplete` / `hostFsStat`, `ownedNamespacesEndpoint`, `getEmitStatus`, `previewRewindEndpoint`, `fetchUgTab`, `findLoopsEndpoint`, the five Sonata `getSong*` GETs and `getUgAlignment`.
- **§4 Lint.** `live/no-endpoint-read` keeps the TanStack arm and drops the GET and `readNdjson` arms. Two arms are new: "a write's answer used in read context" (any method, `fetchEndpoint` / `mutateAsync`) and "a `LiveReader` call in read context". Today it has 0 hits across the repo.
- **§5 Guard.** The new leaf `primitives/networking/plugins/request-guard` covers fetch, XHR, sendBeacon, EventSource and WebSocket, with `nativeFetch` / `nativeWebSocket` capabilities. It is installed by `web-core/web/install-request-guard.ts`, imported first in `main.tsx`.
  - Asset routes come from `ASSET_MIRROR_PREFIX` and every URL `assetUrlOver` hands out.
  - Refusals are filed as `browser-error` with errorType `RawApiRequestError`.
  - The new `networking/no-request-guard-capability` lint is `noDebt`.
  - The e2e helper `pageFetch` (over `page.request`) replaces 25 in-page `fetch("/api…")` calls, and `agent-origin-safety/no-unmarked-app-fetch` gains an `inPage` arm.
  - `probeUrlStatus(transport, url)` is in; `ReconnectingEventSource` is deleted.
- **§6 `noDebt`.**
  - `LintContribution.noDebt` is validated in the new `lint/core/scope-declaration.ts`.
  - `ruleIdProblems` refuses debt on a `noDebt` rule.
  - The generator emits `SanctionedOnlyRuleId` and `DebtableRuleId = Exclude<ExemptableRuleId, SanctionedOnlyRuleId>`, and `DebtExemption.rule` is narrowed to `DebtableRuleId`.
  - `noDebt` is applied to `live/no-endpoint-read`, `endpoints/no-raw-web-fetch`, `networking/no-page-transport` and `networking/no-request-guard-capability`.
  - `endpoints:typed-web-fetches` is retired.

### Deviations

- **The tsc error does not read out the `ReadMarker` sentence.** tsc reports "The intersection 'EndpointDef<"GET /api/health", …> & WriteEndpoint' was reduced to 'never' because property 'read' has conflicting types". The sentence shows when you hover the def's `read`. Every marker shape that prints the sentence loses the inferred params, body and response types. The endpoints CLAUDE.md documents the real message.
- **`useLiveReader`:**
  - `LiveAnswer` has a `refused` arm only when the value declares refusals.
  - "Observed" also requires an open socket, no query error and no pending `invalidate`.
  - Reads of an observed tuple reuse `fetchOverHttp`'s `"fallback"` report label.
- **Sonata:** hydration is a `<SongHydrator songId>` render-prop chain, one element per contribution, not a `useSongHydration` hook (a hook cannot render the chain). chord-grid and transcription read their own `songLibrary` row fields instead of new collections. `ugAlignmentRows` moved from alignment's `shared/` to `alignment/core`.
- **Chord:**
  - The two cross-field refines moved to the loader as `checkFindLoops`, which refuses `invalid-query`. Inside the query schema the browser's encode would throw first.
  - `useLive` takes `[]` rather than `null` when nothing is requested.
  - The e2e scripts read `GET /api/resources/chord.loops?q=…`.
- **`build.serve-owned`** is `load: "snapshot"` (re-read at each delete), not shaped like `serveStatus`. It refuses nothing: an id that is not a namespace label owns nothing.
- **Mail:** `mail-html` gained `onUnresolvedCids`, so the write fires from an effect, not from inside `resolveCid`'s `useMemo`.
- **Lint:** the event-registrar pattern widens to any `subscribe…` name. `clientLog`'s flush is reached from `subscribeWsStatus`, not from a timer as the plan said.
- **Guard:**
  - The WebSocket capability is a function, `nativeWebSocket(url, protocols?)`, not a class.
  - Refusals reuse the `browser-error` source.
  - Inside `natives` there is one named `install-sink` disable, because the guard runs before React.
- **Task launch** calls `buildTaskPrompt` directly, not `resolveLaunchPrompt`. Passing the armed prompt would change what a manual Launch sends.
- **Integration:**
  - Three new values read Postgres from an external loader, so they carry **sanctioned** `no-db-backed-notify` entries:
    - `chord.loops`: a fixed random sample per round
    - `attachments.bytes`: immutable by id
    - `conversations.rewind-preview`: a snapshot
  - `LoopCandidateSchema` moved to `song-index/core/testing` and `ResourceErrorInfo` to `live-state/web/testing`; only tests import them (R13).
  - In the lint, the `switch` on `parent.type` became an if-chain to satisfy `switch-exhaustiveness-check`.

### Measurements and verification

| Check | Result |
|---|---|
| `./equin build` (checks included) | green, `build-1793037665-mp6t2y` |
| `./equin test` on 39 touched plugin paths | 2095 pass, 1 fail: `reports/crash` `crash-kind.test.ts`, pre-existing (see Open) |
| `exempt list --debt` for `live/no-endpoint-read`, `endpoints/no-raw-web-fetch`, `networking/no-page-transport`, `networking/no-request-guard-capability` | 0 each (sanctioned: 2, 9, …) |
| Scratch `fetchEndpoint(getHealth, {})` in `web/` | TS2769, "reduced to 'never' because property 'read' has conflicting types" (scratch deleted) |
| Guard (`browser_javascript`) | fetch rejects; XHR, sendBeacon, EventSource and WebSocket throw `RawApiRequestError`; cross-origin fetch passes; each refusal filed in `reports` as `browser-error` |
| App boot, /chord, /sonata, /files, conversation pane | no refusal, no console error |
| Piano samples (asset mirror) | 200, played |
| Chord trainer | 8 Next songs, 8 distinct loops; refills read `chord.loops` over HTTP |
| Sonata | loaded, no errors: chord-grid, MIDI (`attachments.bytes` 200), MusicXML, UG aligned, transcription (ready) |
| File explorer path bar | `~/Do` completes `~/Documents` and `~/Downloads`; a relative prefix shows the `invalid-path` message; validating a missing path shows "No such file or folder"; `~/Music` navigates |
| `url-paste-link-verify.ts` (uses `pageFetch`) | ALL CHECKS PASSED (28), including E: Mention retitles the link |
| `container-collapse-verify.ts` (`pageFetch`) | ALL CHECKS PASSED (16) |
| `/api/resources/_debug` | lists every new key with its freshness |
| Refusals over HTTP | `rewind-preview` (`not-found`, `nothing-before`, `not-a-live-user-prompt`), `ultimate-guitar.tab` (`invalid-url`), `link-meta` (`blocked`); `serve-owned` answers `{ namespaces: [] }` |

**Not exercised live:**
- The rewind dialog UI (the transcript row actions were virtualized off screen; the value was checked over HTTP).
- Studio's delete-composition confirm.
- The UG import dialog and the in-player loader.
- Mail `cid:` images (no synced mail in this fork).
- Task Launch, from the detail pane and from the row action (it would spawn a real agent).
- Drag-to-pin.
- A live Sonata source change while playing.
- `dismiss-all-verify.ts` fails before any `pageFetch`: `boot()` waits for `[data-app-tab]`, which the default solo surface mode hides. This is pre-existing, not this change.

### Open

- **`crash-kind.test.ts` is pinned to a fingerprint that the rename commit `e1d036882b` changed.** It swapped the fixture's host to `equin.localhost`, so the pin is stale on HEAD. It is unrelated to this change.
- **`dismiss-all-verify.ts`'s `boot` marker** (`[data-app-tab]`) does not exist in solo mode.
- **Guard:**
  - `assetUrlOver` registers its route during render. This is idempotent, but it is a side effect in render.
  - On the demo transport, a probe of a cross-origin image goes to the in-browser server.
- **`chord.loops`:** the encoded question must stay under `LIVE_QUERY_MAX_BYTES` (about 50 playable chords at the exclusion cap).
- **Residual, recorded in §4:** a POST read issued from an event handler is held by review.

### Review fixes

1. **`no-endpoint-read` missed an aliased `mutateAsync`** (`const { mutateAsync: findLoops } = …`, `const run = m.mutateAsync`). `writeClient` now also follows where an Identifier callee was bound (`boundFromMutateAsync`: a renamed object-pattern destructure, parameter included, or a `const x = m.mutateAsync`), reported as `mutateAsync`. RuleTester case added (renamed destructure, renamed parameter destructure, member-assigned local); the rule doc says aliases are covered.
2. **The `LiveReader` arm was gated on the file's text** (`mayHoldReader`), so a reader reaching a file through a hook's return / destructure / context went unchecked. The gate is gone: read context is decided first (AST), and only then is the type checker asked — skipping callees bound to an import, a declared function or class, or a global (never a reader). RuleTester case: a hook returning `{ read: useLiveReader() }`, destructured and called in an effect.
3. **`readOnce`'s fast path trusted a value cached before the current subscription** (after a reconnect's replay, or a remount after the keep-alive teardown). `holdsCurrentValue` now also requires the sub to have been answered since its last (re)subscribe (`sub.version >= 0`; every fresh / replayed / forced sub resets it to -1), else it falls through to the guarded HTTP read. Docs on `readOnce`, `holdsCurrentValue` and live-state's CLAUDE.md updated.
4. **The request guard refused by-URL re-fetches of the page's own images** (Screenshot / Draw-on-app's `modern-screenshot` inlining every `<img>`). `useAssetSrc` now registers every path it hands an element (`allowAssetRoute` in `staticSrc`'s ready branch; sanctioned exemption extended to `asset-src.ts`), and the desktop wallpaper no longer hand-builds `/api/wallpaper/image?v=…`: it is `assetPath(wallpaperImage, {}, { v })` through `useAssetSrc` (no backdrop while an in-browser server fetches the bytes). request-guard's CLAUDE.md and `guard.ts` doc updated.
5. **The trainer's loop find could outgrow `LIVE_QUERY_MAX_BYTES`** (the learner's whole selection was in the typed query; the encode throws in render). The selection is no longer sent: curriculum serves a new live value `chord.curriculum.loops` (`chordCurriculumLoops`) whose query is song-index's `LoopFindOptionsSchema` (focus, shape, features, capped exclusions, limit) plus the `round` nonce; its loader reads the stored selection (`loadSelection`) and answers through song-index's new server export `answerLoopFind` (refusing `invalid-query` when nothing is practised or the focus is not practised). The trainer reads it instead of `chord.loops`, which stays for small explicit finds (the e2e flows). No cycle: curriculum already depends on song-index. CLAUDE.md of trainer, curriculum and song-index updated.
6. **`recording/e2e/video-sync.ts` still read the deleted UG GET routes.** It now reads the two lookup-only collections over their HTTP point read (`/api/resources/sonata.ultimate-guitar.songs:rows?ids=<song>` and `sonata-ug-alignment:rows`), rebuilding the `UgTab` from the row's fields as the UG hydration does.
7. **A library Play depended on the row staying mounted.** New app-level wrapper slot `Sonata.Provider` (shell; folded around the whole surface inside the player scope, in `SonataLayout`); library contributes `BackgroundPlayProvider`, which owns the one `pendingPlay` and renders the hydrate-then-play host. `useSonataPlayback` only asks it (and throws outside it); `PlaySongAction` no longer renders a host.
8. **Hydration had no barrier between the song row and the owning source's content** (a transcription marked ready while its MusicXML row lagged → an empty score loaded for good). `SongHydrator` now reads the song's own `source` (`useLiveRow(songLibrary, id)`), and `combineHydrations(bySource, owner)` answers a new `SongHydration` arm, `awaiting-owner`, while every source answered, none is pending and the owner (when it is a contributed source) has no raw yet (a union arm, not a hand-rolled `loading` — `live-state/no-handrolled-result` — so tsc makes both hosts handle it); the player pane and background play render their loading state instead of loading an empty score. Tests added in `hydrate-sources.test.ts`.
9. **A dead pasted link filed an app-defect report** (only `SsrfError` / `PageFetchError` were refusals). safe-fetch now owns the classification without changing what it throws to its other callers: `TooManyRedirectsError` (was a plain `Error`) and `isUnreachableError(err)` — DNS / dial errors by their network `code` (Bun's fetch throws a `TypeError` carrying `ECONNREFUSED` / `ENOTFOUND`; a code-less `TypeError` is a bug and does not count), `TimeoutError` / `AbortError`, too many redirects. Both bookmark loaders (`link-meta`, `link-preview`) refuse those as `unreachable`. Unit tests in `ssrf.test.ts`.
