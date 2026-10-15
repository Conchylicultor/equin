# thumbnails

Rendered PNG previews for the gallery's cards. A prototype is a live React app
that compiles its JSX in the browser, so a picture of one means **running it** —
Chromium is the renderer; this plugin owns the caching around it.

```
edit under prototypes/
  → files' watcher (the ONLY one over that tree) fires onPrototypesChanged
  → syncThumbnails(): fingerprint every folder, decide, push state, enqueue
  → prototypes.render-thumbnail: chromium → PNG → cache → notify
  → the card's <img> src changes; nothing polled
```

`syncThumbnails` is the only thing that decides what needs rendering, and it
decides from the fingerprint alone — so it is idempotent, and boot and a file
change are the same call.

## Decisions that look wrong until you know why

**The change signal is borrowed.** `files` owns the prototypes tree and already
watches it; a second `@parcel/watcher` over the same tree doubles every event.
So `files` exports `onPrototypesChanged` / `listPrototypeMetas` and this plugin
listens instead of watching. `prototypesDir` comes from the app root's
`data-dirs/` (`@plugins/apps/plugins/prototypes/data-dirs`, the app's one
`apps/prototypes` dir) — imported at its home, never through `files`' barrel,
which would be a cross-plugin re-export. A data dir is declared exactly once,
so re-deriving the path here would be the bug.

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
worktrees must collide on purpose.

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

`<PrototypeThumbnail state fallback />` renders the three arms. `fallback` is the
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

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The rendered-preview cover for a prototype card: the cached PNG, the caller's fallback while it renders, and a visible 'Preview failed' marker carrying the reason. Rendered PNG previews for the prototypes gallery: a content-addressed disk cache, a headless-chromium render job driven by the files watcher, the push state resource the cards read, and the immutable serving route.
- Server:
  - Contributes: `resource.declare` "prototypes.thumbnails"
  - Uses:
    - `apps/prototypes/files.listPrototypeMetas`
    - `apps/prototypes/files.onPrototypesChanged`
    - `infra/deps.onDepInstallSettled`
    - `infra/deps.requestDep`
    - `infra/jobs.defineJob`
    - `network/live.serveValue`
  - Register:
    - `defineJob('prototypes.render-thumbnail')`
    - `defineJob('prototypes.sweep-thumbnails')`
  - Resources: `prototypes.thumbnails` (push, notified)
- Web:
  - Uses:
    - `network/live.useLive`
    - `primitives/css/badge.Badge`
    - `primitives/css/overlay.Overlay`
    - `primitives/css/pin.Pin`
    - `primitives/overlay/tooltip.WithTooltip`
    - `ui/icons.Icon`
  - Exports (values):
    - `PrototypeThumbnail`
    - `usePrototypeThumbnails`
- Core:
  - Uses: `network/live.liveValue`
  - Exports (types):
    - `ThumbnailFailureKind`
    - `ThumbnailState`
  - Exports (values):
    - `PROTOTYPE_THUMB_ROUTE`
    - `PROTOTYPE_THUMBS_BASE`
    - `prototypeThumbnails`
    - `prototypeThumbnailUrl`
    - `ThumbnailFailureKindSchema`
    - `ThumbnailStateSchema`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shadow --shadow`
  - Imported by: `apps/prototypes/gallery`

<!-- AUTOGENERATED:END -->
