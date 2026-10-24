# Prototype gallery thumbnails — rendered previews as gallery covers

## Context

The Prototypes gallery (`/prototypes`) shows one card per mock, and each card's
cover is a **colored gradient derived from the folder slug** — decorative, and
carrying no information about the prototype. You cannot tell two mocks apart
without opening them, which is exactly what a gallery is for.

The goal: each card shows a picture of the prototype as it actually renders.

A prototype is a live React app that pulls React + Babel from unpkg and compiles
its JSX in the browser, so producing a picture means **running the page** — no
DOM-to-image library, no QuickLook thumbnail, and no in-browser canvas capture
can do it (a page's own JS cannot rasterize a cross-document iframe). Chromium is
the only faithful renderer. It is already installed and already used server-side
by `browser-fetch`, so the new weight is the caching, not the browsing.

Rejected alternatives, and why:

- **A live iframe per card.** Ten lines, and the Compare tab already proves the
  shape — but every card downloads ~4 MB of CDN scripts and runs its own Babel
  compile, so the gallery gets slower with each prototype added, and the cards
  come up blank with no network.
- **An author-time `preview.png` committed in each prototype folder.** Nearly
  free, but it goes stale the moment anyone hand-edits a prototype, and keeping
  it fresh is exactly the "you must also update X" coupling this repo treats as a
  bug to be designed out.

## What the user sees

Open `/prototypes`: each card shows a shrunken screenshot of that prototype.
Edit a prototype's file; within a couple of seconds its card updates itself. A
prototype that cannot be rendered (offline, dead CDN, broken page) keeps today's
gradient and carries a small **"Preview failed"** marker whose tooltip says why.
Nothing is ever cached from a failed or blank render, so the next edit retries.

## Design

One new sub-plugin owns the whole feature:
`plugins/apps/plugins/prototypes/plugins/thumbnails/`.

### The one signal it needs from outside

`files` owns `prototypes/` and already runs the only watcher over it
(`files/server/internal/watcher.ts`). It must not be double-watched, so `files`
exposes the change signal it already computes:

```ts
// plugins/apps/plugins/prototypes/plugins/files/server/index.ts
export function onPrototypesChanged(listener: () => void): void;
```

An in-process listener list, invoked from the existing `onChange` alongside the
current `bumpPrototypesVersion()` / `notify()` calls. This is the **only** edit
outside the new sub-plugin apart from the gallery's cover line.

### Rendering

`server/internal/render.ts` — one function, one job:

```ts
renderThumbnail(meta: PrototypeMeta): Promise<Uint8Array>  // throws, never returns a blank
```

- `import("playwright")` is **dynamic and memoized**, never at module eval —
  Playwright costs ~3 s of module evaluation, and `browser-fetch` pays this same
  care (`browser-fetch/internal/browser-fetch.ts`).
- `ensureChromium()` from
  `@plugins/infra/plugins/safe-fetch/plugins/browser-fetch/core` at job start.
  It is idempotent and already runs at install time, so no new provisioning.
- `chromium.launch()` with the non-SSRF subset of `browser-fetch`'s
  `buildLaunchArgs` (`--disable-background-networking`, `--no-first-run`,
  `--disable-sync`, `--disable-component-update`,
  `--js-flags=--max-old-space-size=512`). **Keep the sandbox on** — a prototype
  is arbitrary JS. Launch-per-render, closed in `finally`.
- `page.goto("file://<REPO_ROOT>/prototypes/<name>/index.html", { waitUntil: "networkidle" })`.
  `file://` works because a prototype renders off disk by contract — no gateway
  or socket routing to arrange.
- Viewport is the prototype's own `meta.viewport`, with
  **`deviceScaleFactor: 0.5`** — a 1280×800 prototype yields a 640×400 PNG, so
  no image-resize dependency is needed.
- **Never cache a lie.** Collect `page.on("requestfailed")`; after settle, throw
  a typed `ThumbnailRenderError` when a *script* request failed
  (`kind: "subresource-failed"`, the offline / dead-CDN case) or the body has no
  text and no `canvas`/`svg`/`img` (`kind: "blank-page"`). A whole-op deadline
  (~30 s) throws rather than screenshotting a half-loaded page — the same
  discipline as `browser-fetch`.
- Bounded by a module-level `createSemaphore(1)`
  (`@plugins/packages/plugins/semaphore/core`) so one backend runs at most one
  browser. **Known limit, stated rather than hidden:** this does not bound
  Chromium *across* worktrees the way `browser-fetch`'s host pool does. Renders
  are rare and short, so the follow-up (a `RESERVED_POOLS` entry in
  `host-admission/core`, or sharing `browser-fetch`'s existing size-2 pool) is
  only worth doing if many agents open prototype galleries at once.

### Cache

Content-addressed, host-global: `~/.singularity/prototype-thumbnails/<sha>.png`,
following `asset-mirror`'s precedent (`join(SINGULARITY_DIR, …)`, atomic
temp-file + `rename`). The key is a sha256 over the folder's files (relative
path + bytes, sorted) — prototypes are ~20 KB, so hashing content rather than
`(mtime,size)` is cheap and lets two worktrees holding the same prototype share
one rendered PNG.

A nightly `defineJob` (cron, main-only) unlinks PNGs untouched for 30 days; a
swept file that is still wanted is simply re-rendered.

### State, and how the card learns about it

`core/thumbnails.ts` declares the discriminated per-prototype state — a failure
is a state, never an absent image:

```ts
type ThumbnailState =
  | { status: "ready"; key: string }        // key = content hash → immutable URL
  | { status: "rendering" }
  | { status: "failed"; kind: ThumbnailFailureKind; message: string };

export const prototypeThumbnailsResource =
  resourceDescriptor<Record<string, ThumbnailState>>("prototypes.thumbnails", …);
```

A `mode: "push"` resource (`defineExternalResource`), mirroring
`files/server/internal/resources.ts`. Flow on any change under `prototypes/`:

1. `onPrototypesChanged` fires → re-fingerprint each folder.
2. A folder whose current hash has no cached PNG enqueues
   `thumbnails.render` (`defineJob`, `dedup: { key: name }`, so a burst of saves
   collapses to one render per prototype; `maxAttempts: 1`, since a broken
   prototype should surface, not retry-storm).
3. The job renders, writes the PNG, and notifies the resource — which pushes
   `ready` (with the new key) or `failed` to every open gallery.
4. `onReady` runs the same sweep once, so a fresh backend fills its cache.

### Serving

A raw byte route (`asset-mirror` / `handlePrototypeAsset` shape), on its own
prefix so it cannot be shadowed by the existing single-segment
`GET /api/prototypes/:name/:file`:

```
GET /api/prototype-thumbs/:key   →  PNG, "cache-control: public, max-age=31536000, immutable"
```

Immutable is honest here: the URL contains the content hash, so an edit yields a
different URL rather than a stale hit.

### The card

`web/components/prototype-thumbnail.tsx` renders the three arms — image,
fallback while rendering, fallback + "Preview failed" marker (tooltip carries
`message`). The gallery keeps its own `CoverSwatch` art and passes it in, so
each plugin owns its own half:

```tsx
// plugins/apps/plugins/prototypes/plugins/gallery/web/components/prototype-gallery.tsx
cover: (p) => ({
  kind: "node",
  node: <PrototypeThumbnail name={p.name} fallback={<CoverSwatch meta={p} />} />,
}),
```

## Files

**New** — `plugins/apps/plugins/prototypes/plugins/thumbnails/`:

| Path | Holds |
|---|---|
| `core/thumbnails.ts` | `ThumbnailState` + schema, resource descriptor, route key, `thumbnailUrl(key)` |
| `server/internal/fingerprint.ts` | folder content hash |
| `server/internal/cache.ts` | cache dir, atomic write, existence check, sweep |
| `server/internal/render.ts` | Playwright launch → screenshot → guards |
| `server/internal/state.ts` | the name→state map + `notify()` |
| `server/internal/jobs.ts` | render job (per-name dedup) + nightly sweep job |
| `server/internal/route.ts` | raw PNG handler |
| `server/index.ts` | `httpRoutes`, `Resource.Declare`, `register: [renderJob, sweepJob]`, `onReady` |
| `web/components/prototype-thumbnail.tsx`, `web/index.ts` | the three-arm cover component |
| `CLAUDE.md`, `package.json` | plugin docs + the `playwright` dependency |

**Edited** (two lines of substance each):

- `plugins/apps/plugins/prototypes/plugins/files/server/index.ts` +
  `internal/watcher.ts` — export and fire `onPrototypesChanged`.
- `plugins/apps/plugins/prototypes/plugins/gallery/web/components/prototype-gallery.tsx`
  — the `cover` accessor above.
- `plugins/apps/plugins/prototypes/CLAUDE.md` — name the new sub-plugin.

No DB table, so **no migration**.

## Reuse

- `ensureChromium()` — `infra/safe-fetch/browser-fetch/core` (already provisioned
  at install; do not add a second provisioning step).
- Launch args, deadline clamping, and the "throw rather than return a partial
  page" discipline — copy the shape from
  `browser-fetch/server/internal/{launch-args,browser-fetch,deadline}.ts`.
- `createSemaphore` — `packages/semaphore/core`.
- `defineJob` — `infra/jobs/server`; the tick-fans-out-to-keyed-jobs shape is
  `apps/events/refresh/server/internal/jobs.ts`.
- Disk cache + atomic write + raw byte route —
  `infra/asset-mirror/server/internal/{fetch-to-disk,handle-mirror}.ts`.
- `defineExternalResource` push resource — `files/server/internal/resources.ts`.
- `SINGULARITY_DIR` — `infra/paths`.

## Verification

Unit (`./equin test plugins/apps/plugins/prototypes/plugins/thumbnails`) —
the pure logic, as `*.test.ts` beside its source:

- fingerprint: stable across reads, changes on a byte change, independent of
  file order;
- state derivation: cached key present → `ready`; absent → enqueue + `rendering`;
- the render classifier: a failed script request → `subresource-failed`, an
  empty body → `blank-page`, a normal page → pass.

End to end, after `./equin build` (background, per the agent workflow):

1. Open `http://<worktree>.localhost:9000/prototypes` — `helix` and
   `mist-panes` cards show real screenshots.
2. `ls ~/.singularity/prototype-thumbnails/` — two `<sha>.png` files.
3. Edit `prototypes/helix/index.html` (change a heading), save, and watch that
   card update on its own within a few seconds; a new `<sha>.png` appears.
4. Break it on purpose — point the React `<script src>` at a nonexistent host —
   and confirm the card falls back to the gradient with a "Preview failed"
   marker, and that **no** PNG was written for that hash.
5. Screenshot the result for the record:
   `bun run playwright screenshot --wait-for-timeout 3000 --viewport-size "1280,800" http://<worktree>.localhost:9000/prototypes /tmp/gallery.png`
6. `./equin check` — in particular `prototypes:self-contained` still
   passes (the cache lives outside `prototypes/`, so no folder gains a file or a
   subdirectory).
