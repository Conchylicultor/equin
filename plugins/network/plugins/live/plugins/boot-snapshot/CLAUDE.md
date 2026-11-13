# boot-snapshot

Makes a cold page load feel instant by eliminating the boot burst's per-resource
WS round-trips for **boot-critical** resources — they ship in one snapshot
request. See
[the cold-load plan](../../../../../../research/2026-06-14-global-cold-load-instant-boot.md).

A resource opts in **one-sidedly** — a single declaration in the resource's own
plugin:

- **The shared descriptor (the single source)** — declare it preloaded:
  `liveValue("k", { schema, preload: "boot" })` (or `"boot-and-keep"`), a
  collection's `preload: "boot"`, or `preload: "boot"` in an old descriptor
  factory's options. `Resource.Declare(resource)` derives the flag from the
  served resource, and the server reads the set generically
  (`preloadedKeys()`: `Resource.Declare.getContributions().filter(c => c.preload !== undefined)`),
  never by name. This drives the snapshot endpoint. The L2 persisted set is
  the runtime's `persistedKeys()` — a preloaded key the runtime persists, never
  a bounded or external one — read through live-state-snapshot's usable-row
  predicate.
- **Client (auto-derived — no second list)** — the boot task no longer maintains
  a parallel client registry. It iterates the **keys** the snapshot already ships
  and resolves each to its client `ResourceDescriptor` via the live-state
  descriptor registry (`resourceDescriptorByKey` from
  `@plugins/network/plugins/live/plugins/live-state/web`), then `hydrateResource`s it before
  paint. Adding a boot-critical resource — or splitting one into N sub-resources —
  is therefore a **server-only edit**: the descriptors self-register on import, so
  there is no second list to keep in sync and the old silent-drift class (forget a
  client `Hydrate` and that list quietly loses pre-paint hydration) is gone.

**The request starts at t0, in the shell's head.** The server half contributes a
`DocumentHead.Fragment` (`server/internal/head-request.ts`): an inline async module
script that sends the snapshot GET while the HTML is parsed — in parallel with the
modulepreloads — and parks it on `globalThis[HEAD_REQUEST_GLOBAL]`
(`shared/head-request.ts`). The boot task takes it once and reads its reply through
the endpoint's codec; with no head request (a shell served without the fragment, or
a second boot after Retry) it sends the request itself. The head script's request
is pinned to the one `sendEndpointRequest` builds by `head-request.test.ts`. Before
this the GET waited for the whole eager tier to download and evaluate (S1 of
`research/2026-11-12-global-load-model-redesign.md`).

**One hydrate path — `hydrateBootSnapshot(snapshot)`** (web): resolves every
snapshot key, hydrates it, and returns `{ missing, failed }` for the caller to
surface. The boot task reports them; a static render
(`primitives/dom/static-render`) throws on `failed`. A snapshot never reaches the
cache any other way.

**Invariant:** a boot-critical resource's descriptor must sit in the **eager web
import graph** so it is registered before the boot task runs. This holds today
because a boot-critical resource is, by definition, read by boot-mounted UI, which
pulls its descriptor module in eagerly. If a descriptor is ever only *lazily*
imported, the snapshot will carry a key the registry can't resolve — and boot
files a **loud `crash` report** (`source: "boot-snapshot"`, "unresolved descriptor
key(s): …") plus a console error, rather than silently dropping that resource's
hydration. (`report()` is a direct keepalive POST because the crash collector's
window listeners are not mounted yet during the boot window.)

Two kinds of preload, told apart by the `Resource.Declare` payload alone:

- **Default tuple** — a param-less resource, or a collection's default window
  (`defaultParams`). Shipped in `resources[key]`, from the first of:
  1. **memory** — a persisted alias (an unbounded-window `scopedMembership` key,
     `unboundedWindowKeys()`) that holds its kept in-memory snapshot is served
     from it (`keptSnapshotValue`): its L2 row trails it by up to one
     floor-persist window, so the row is the OLDER value;
  2. **persisted** — the L2 row, when there is a USABLE one: the read applies
     live-state-snapshot's usable-row predicate (a key the runtime persists right
     now, under its current definition, written by a current writer), so a
     bounded preloaded window — or any key a previous boot left a row for — is
     never served from L2;
  3. **loader** — loaded at the descriptor's `defaultParams`.

  `timings[key].source` names which (`memory` | `persisted` | `loader`).
  A collection's whole ordered set (`liveCollection(key, { all })`) is one of
  these: a param-less tuple (its descriptor has no `defaultParams`),
  self-registered under `key` itself so the client resolves it — pinned with
  the real registry and `hydrateResource` by `web/__tests__/boot-all.test.ts`
  (C39 of `research/2026-10-06-global-scoped-change-routing-p8-v3.md`).
  Boot-bench's cold mode bypasses the memory path (`assembleBootSnapshot({ memory:
  false })`), so a cleared L2 really measures the loaders.
- **Enumerated** — a parameterized `liveValue` declared `preload`, whose
  `serveValue` names its tuples (`preloadParams`); the Declare carries
  `preloadTuples`, which loads each through the resource's own `load` (the
  loader alone, sequential per key — no flight, no commit watermark: nothing
  compares these values causally). Shipped in `tuples[key]` as
  `{ params, value }`; the client hydrates each. Never L2-persisted.
  **Per composition:** each enumerated tuple names the web plugin whose page
  reads it, and `assembleBootSnapshot({ webPlugins })` loads only those of the
  page's composition — the endpoint passes its backend's
  `composedWebPlugins()`, the crawlable static host its composition's. A
  config document of the mail app never rides the public website's snapshot
  (2026-11-13: website snapshot 134 KB → 35 KB raw, 412 config documents → 59). Config's
  documents are the first user. A collection's `:rows` sibling served with
  `preloadRows: { idsOf }` is one too: its one tuple is the id set of another
  preloaded collection's boot value (network/live's *Preload*).

A route-parametrized resource nobody enumerates self-heals via its normal sub-ack.
A load that fails is omitted from the snapshot and reported (server error
reporter); a value the client schema rejects is skipped and reported (one bad
entry never stops the others from hydrating).

This plugin no longer runs a server-side warm-up. Cold boot is now a pure
snapshot read: `live-state-snapshot` persists each boot-critical resource's value
**and** its read-set durably, seeds the in-memory table→resource index from that
read-set at boot, seeds each persisted alias (a collection declared `all`, any
unbounded-window `scopedMembership` key) from its row, and runs a **bounded**
changelog catch-up — so no boot-critical loader runs at boot unless its tables
actually changed during downtime (and then an alias refills by scope), or it has
no usable persisted row yet, or the backstop fires (history pruned past the
oldest row, or a healed rollup: every persisted key recomputes; live-state-snapshot's
CLAUDE.md, *Boot flow*). See
[the L3 plan](../../../../../../research/2026-06-23-global-live-state-persisted-read-set-no-boot-recompute.md).

How it works:

- **Snapshot endpoint** `GET /api/resources/boot-snapshot` returns
  `{ resources: Record<key, value>, tuples: Record<key, { params, value }[]>,
  timings }` — every preloaded resource loaded in one request (a failed loader
  is omitted and reported, not fatal).
- **Client boot task** (`Core.Boot`) fetches that snapshot once and, for each key
  it ships, resolves the descriptor via `resourceDescriptorByKey` and
  `hydrateResource`s it before first render — no flash, no WS round-trip. Any
  unresolved key is reported loudly (see the invariant above).
- **When the snapshot does not come** — the task is `Core.Boot({ label: "Boot
  snapshot", ifUnavailable: "block" })`, so App's boot screen (web-core) names it
  while it is pending (after a 3s grace), turns into a loud `stuck` state past the
  boot deadline and a `failed` state when it rejects (Retry / Continue anyway),
  and files a `client-boot-task` report. Verified by `e2e/boot-stall.ts`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Hydrates all boot-critical resources from a single boot snapshot before first paint. Single-request boot snapshot of all boot-critical resources, hydrated client-side before first paint. The SPA shell's head starts the request (DocumentHead.Fragment), so it runs in parallel with the module downloads rather than after the eager tier.
- Web:
  - Contributes: `Core.Boot`
  - Uses:
    - `network/live/live-state.hydrateResource`
    - `network/live/live-state.resourceDescriptorByKey`
    - `primitives/networking/page-transport.pageTransport`
    - `primitives/perfs/boot-trace.recordBootSpan`
    - `reports.report`
  - Exports (types):
    - `BootSnapshotHydration`
    - `BootSnapshotValues`
  - Exports (values): `hydrateBootSnapshot`
- Server:
  - Contributes: `DocumentHead.Fragment` "boot-snapshot"
  - Uses:
    - `infra/endpoints.endpointPath`
    - `infra/endpoints.implement`
    - `network/live/live-state-snapshot.readPersistedSnapshots`
    - `shell/document-head.DocumentHead`
  - Exports (values):
    - `assembleBootSnapshot`
    - `preloadedKeys`
  - Routes: `GET /api/resources/boot-snapshot`
- Core:
  - Uses: `infra/endpoints.defineEndpoint`
  - Exports (types): `BootSnapshotSource`
  - Exports (values): `bootSnapshot`
- Cross-plugin:
  - Imported by:
    - `debug/profiling/boot-bench`
    - `primitives/dom/static-render`
  - Endpoint callers:
    - `boot-bench`
    - `live-state`
    - `live-state-stale-drop`
    - `read-set`
    - `runtime`
- Exemptions:
  - Exempts itself from:
    - `networking/no-page-transport` — `web/internal/boot.ts` (sanctioned)
    - `endpoints/no-raw-web-fetch` — `web/internal/boot.ts` (sanctioned)

<!-- AUTOGENERATED:END -->
