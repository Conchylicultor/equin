# thumbnails

Rendered PNG previews for the gallery's cards. A prototype is a live React app
that compiles its JSX in the browser, so a picture of one means **running it** —
Chromium is the renderer; this plugin owns the caching around it.

```
edit under prototypes/
  → files' watcher (the ONLY one over that tree) fires onPrototypesChanged(changed)
  → syncChangedThumbnails(changed): fingerprint those folders, decide, push state, ask the renderer
  → prototypes.render-thumbnail: chromium → PNG → cache → notify
  → the card's <img> src changes; nothing polled
```

`syncThumbnails` (boot, and a settled browser install: every folder) and
`syncChangedThumbnails` (a tree change: only the prototypes it names) are the
only things that decide what needs rendering, and both decide from the
fingerprint alone — so they are idempotent. Every backend on the box runs them
(the files watcher runs in each), so their cost is paid ×N per edit and per
boot: they take the prototypes' **names** (`listPrototypeNames`, the folder
listing), never `listPrototypeMetas` — which reads, validates and parses every
folder, and was ~2–4 s of every sync before. The render job reads its one
prototype with `readPrototypeMeta` for the same reason.

## Hosts: what is portable, what the host brings

`server/` is portable: the state map, `syncThumbnails`, the fingerprint (over
the `prototypesFiles` root; the hash itself is `core`'s pure `fingerprintFiles`,
so a reader holding a folder's files in hand — the demo's seed check — names
its picture the same way), the
cache (its own `thumbnailCache` file root over `cache/prototypes-thumbnails`)
and the PNG route. The one thing a host brings is the **renderer**, the
`ThumbnailRenderer` host service (`server/internal/renderer.ts`), a union:

- `renders` — `thumbnails#machine`: headless Chromium through Playwright, the
  `render-thumbnail` / `sweep-thumbnails` jobs, `requestDep(chromium)` and the
  `onDepInstallSettled` re-sync; it also binds `thumbnailCache` to the data dir
  (`FileRootLocation`).
- `unavailable` — `thumbnails/no-renderer` (base-excluded; the browser host):
  a cache miss becomes the card's `unavailable` state, carrying why. A hit —
  a PNG a demo seed wrote under its fingerprint (`thumbnailCache` is exported
  for that) — is `ready` through the same sync, with no demo branch.

**Rendering another tree.** `./equin prototype thumbnails <tree> --out <dir>`
(`cli/`, declared by `apps/prototypes/commands`) renders every prototype folder
under `<tree>` with the same `renderThumbnail` (which takes the folder's path)
into `<dir>/<fingerprint>.png` — how a prototype fixture's committed
pictures are made (`apps/prototypes/fixtures/scripts/render-fixture-thumbnails.ts`).

**Not `needsMachine`, on purpose.** The gallery joins this value with the list
in `useCombinedResources`, and one unavailable input blanks the whole join —
so "no picture here" is an arm of the value, never the value being
unavailable.

## Decisions that look wrong until you know why

**The change signal is borrowed.** `files` owns the prototypes tree and already
watches it; a second `@parcel/watcher` over the same tree doubles every event.
So `files` exports `onPrototypesChanged` / `listPrototypeNames` /
`readPrototypeMeta` and this plugin listens instead of watching. The tree is
read through the app root's `prototypesFiles` root
(`@plugins/apps/plugins/prototypes/server`) — imported at its home, never
through `files`' barrel, which would be a cross-plugin re-export; only the
Chromium render (machine) opens `prototypesDir`'s `index.html` as a `file://`
URL.

**The cache is content-addressed and host-global** (a `cache/`-kind data dir,
`<sha256>.png` per prototype, `asset-mirror`'s shape).
The filename IS the folder's content hash, which buys three things: two
worktrees holding the same prototype share one render; the route can say
`immutable` and mean it (an edit yields a different URL, never a stale hit); and
the sweep can be a dumb age-based unlink, since anything it drops is
regenerable. It must stay outside `prototypes/` — `prototypes:self-contained`
rejects a subdirectory there.

Hashing **content**, not `(mtime, size)`: a `git checkout` rewrites mtimes
without changing bytes and must not re-render, and identical bytes across
worktrees must collide on purpose. The digest's byte stream is frozen (name,
NUL, bytes, NUL per file, sorted) — it names every PNG already cached, and
`hash-dir.test.ts` pins it to the `node:crypto` value.

**State is in memory, so there is no migration.** Every arm is derivable from
the filesystem (a fingerprint, plus whether its PNG exists) — a table would be a
second copy of what the disk already says, free to rebuild and impossible to
leave stale. It reaches the browser as one live value,
`prototypeThumbnails` (`liveValue("prototypes.thumbnails")` in `core/`), served
from that map by `serveValue(…, { source: "external" })` in
`server/internal/state.ts` (`prototypeThumbnailsServed`, whose `notify()` every
state change calls) and read by `usePrototypeThumbnails()` (`useLive`). It has
no placeholder: before the map loads it is pending, never an empty map.

**`failed` carries the fingerprint it failed at.** That field is what stops a
permanently broken prototype from launching a browser on every unrelated save,
while still giving new bytes a fresh attempt — so "fix it and save" works. The
rule is one pure function, `decideThumbnail`.

**`deviceScaleFactor: 0.5`** keeps the viewport at the prototype's declared CSS
size (its media queries see what their author intended) and drops only raster
density, so a 1440×900 prototype yields a 720×450 PNG **with no image-resizing
dependency**. Do not "fix" this by adding one.

**Playwright is imported dynamically and memoized.** Its module evaluation costs
seconds, which a backend must never pay at boot just because something in its
graph *can* start a browser.

**A render never installs.** Chromium is an on-demand `infra/deps` dependency
(`chromium`, declared by `safe-fetch/browser-fetch`), and this job runs in the
backend with no `ExecContext`, so it only READS: `readyNow(chromium)`, and
`renderThumbnail(meta, ready)` takes the `Ready` (launching through the
playwright-browser kind's `launchChromium`), so a render cannot be spelled
without an installed browser. It was once spelled with one: `ensureChromium()`
downloaded ~150 MB here with the event loop blocked, ahead of every bound in
`render.ts`.

When Chromium is not installed yet the job calls `requestDep(chromium)` and
parks the card in `waiting-for-browser` (a muted "Installing browser" marker —
not a failure, not cached as one). The server registers
`onDepInstallSettled(chromium, …)`: when that install ends, the sync runs again
and `decideThumbnail` re-renders every `waiting-for-browser` card. A FAILED
install becomes `failed` / `browser-unavailable` with the install's error and
the retry command, and is not re-requested.

## Never cache a lie

The render throws a classified `ThumbnailRenderError` rather than return a
picture it does not trust: `subresource-failed` (a script/stylesheet never
loaded — the offline / dead-CDN case, where the page really rendered and what it
rendered shows none of the prototype), `blank-page`, `render-timeout` (a partial
screenshot is indistinguishable from a finished one, so we take none),
`browser-unavailable`.

Waiting for content and detecting blankness are the same act on purpose — the
`waitForFunction` gives an in-browser Babel compile time to paint, and its
timeout IS the verdict. `classifyRenderOutcome` fixes the precedence: a failed
script is reported ahead of blankness, because it is *why* the page is empty.
The `networkidle` ceiling is the opposite — reaching it is the expected path,
since a page holding a connection never idles.

## Bounds

**One browser per backend, enforced by the QUEUE** — `serial: true` on
`render-thumbnail` is graphile's `queue_name`, so a second render is never
fetched while the first runs and therefore holds no worker slot. Never put this
back behind an in-process gate: a semaphore is entered *after* dispatch, so a
waiting render burns a slot, and one wedged render turns every later one into
another wedged slot (it cost main three of four slots for 70 minutes on
2026-08-17).

`dedup` by slug collapses a burst only while the previous row is still
*pending* — graphile cannot replace a row it has already locked — so a fast
burst does produce several rows. `serial` is what makes that harmless.

Every wait is bounded, teardown included; `browser.close()` was the one that
wedged, and `closeBrowser` in `render.ts` says why a timed-out close is logged
and abandoned rather than failing a picture already captured.

**Known limit:** all of this bounds the backend, not the host — `browser-fetch`
has a host-wide pool this does not share. Fine while renders are rare and
short; if galleries get opened across many worktrees at once the fix is a
`HOST_POOLS` entry in `host-admission/core`.

## The card

`<PrototypeThumbnail state fallback />` renders the arms: the PNG, the
fallback, and the fallback with a marker — muted for `waiting-for-browser` and
`unavailable` (nothing wrong with the prototype), a warning for `failed`. `fallback` is the
**caller's** art (the gallery's `CoverSwatch`) — the gallery already owns what a
prototype looks like without a picture. The failure marker sits in an
`Overlay`'s `behind` slot, not `above`: `above` is click-through by design and
would swallow the hover its tooltip needs.

**The card takes the state; it never fetches it.** A value is filled by its
subscription's first answer, asked for when its FIRST subscriber mounts, so a
card that read the value itself could only ask after the list it belongs to had
painted — every load showed the swatch for one round trip and then swapped in
the picture, which is the flicker a user reads as "the thumbnails aren't cached"
(they are: the URL is a content fingerprint served `immutable`). So the surface
that owns the cards subscribes to both at once — `usePrototypeThumbnails()`
beside the list, joined with `useCombinedResources` — and the cover is right the
first time it is painted.
A card with no pending arm has nowhere to put a stand-in-then-swap.

The `<img>` is `decoding="sync"`: a cache hit that decodes asynchronously still
lands a frame or two later, which across a grid reads as the covers popping in
one by one.

Design: `research/2026-08-16-apps-prototype-gallery-thumbnails.md`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The rendered-preview cover for a prototype card: the cached PNG, the caller's fallback while it renders, and a visible 'Preview failed' marker carrying the reason. Rendered PNG previews for the prototypes gallery, on every host: the content-addressed cache (the thumbnailCache file root), the fingerprint sync driven by the files watcher, the push state resource the cards read and the immutable serving route. Rendering is the ThumbnailRenderer host service's — a host without one answers a cache miss as `unavailable`.
- Server:
  - Contributes:
    - `resource.declare` "prototypes.thumbnails"
    - `host-service:prototypes.thumbnail-renderer` "prototypes.thumbnail-renderer"
    - `data-files.root-location` "apps.prototypes.thumbnails"
  - Uses:
    - `apps/prototypes.prototypesFiles`
    - `apps/prototypes/files.listPrototypeNames`
    - `apps/prototypes/files.onPrototypesChanged`
    - `infra/endpoints.rawEndpointHandler`
    - `infra/paths/data-files.defineFileRoot`
    - `network/live.serveValue`
  - Exports (values):
    - `thumbnailCache`
    - `ThumbnailRenderer`
  - Resources: `prototypes.thumbnails` (push, notified, whole: one state per prototype — bounded by the prototype list the gallery holds whole)
  - Routes: `GET /api/prototype-thumbs/:key`
- Web:
  - Uses:
    - `infra/endpoints.useAssetSrc`
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/overlay.Overlay`
    - `primitives/css/pin.Pin`
    - `primitives/loading.Loading`
    - `primitives/overlay/hover-card.WithHoverCard`
    - `ui/icons.Icon`
  - Exports (values):
    - `PrototypeThumbnail`
    - `usePrototypeThumbnails`
- Machine:
  - Uses: `infra/paths/data-files.FileRootLocation`
  - Register:
    - `defineJob('prototypes.render-thumbnail')`
    - `defineJob('prototypes.sweep-thumbnails')`
- Core:
  - Uses:
    - `infra/endpoints.assetPath`
    - `infra/endpoints.AssetPath`
    - `infra/endpoints.blob`
    - `infra/endpoints.defineEndpoint`
    - `network/live.liveValue`
    - `packages/list-bound.wholeRecord`
    - `packages/string-hash.createSha256`
  - Exports (types):
    - `FingerprintedFile`
    - `ThumbnailFailureKind`
    - `ThumbnailState`
  - Exports (values):
    - `fingerprintFiles`
    - `getPrototypeThumbnail`
    - `prototypeThumbnailAsset`
    - `prototypeThumbnails`
    - `ThumbnailFailureKindSchema`
    - `ThumbnailStateSchema`
- Cli:
  - Uses:
    - `apps/prototypes/files.prototypeMetasIn`
    - `infra/jobs/supervised-job.cliExecContext`
  - Exports (values): `renderThumbnailsAction`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shadow --shadow`
  - Imported by:
    - `apps/prototypes/fixtures`
    - `apps/prototypes/gallery`
    - `apps/prototypes/thumbnails/no-renderer`
- Sub-plugins:
  - **`no-renderer`** (excluded) — The prototype thumbnails of a host without a browser to render with: provides the ThumbnailRenderer host service as unavailable, so a cache miss is the card's muted 'Preview unavailable' marker and…

<!-- AUTOGENERATED:END -->
