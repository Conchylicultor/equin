# Sonata in the browser demo

Track: *apps running in the browser* (wiki `block-d04c6c0d-…`), subtrack *portable server code* (`block-323b766d-…`).
Task: task-1793813670-6qj55r. Absorbs sidequest task-1793668424-xpv8t1 (instrument loaders spell `/api/asset-mirror` by hand).
Precedents: Pages (`research/2026-10-24-global-demo-pages-and-in-embed-app-switching.md`), Prototypes (`research/2026-10-24-global-data-files-host-service.md`), per-app fixtures (`research/2026-10-28-global-per-app-demo-seeds-v2.md`).

## Context

The `/demo` embed (`apps/website/demos/lumen`, composition `agent-manager-demo`) runs Agent Manager, Home, Pages and Prototypes on their real server code in a worker on PGlite. Sonata is not in it. It should be: reachable from the launcher, its demo data written by its own fixture writer, every read/write served by the worker or declared `needsMachine`, the coverage guard green with no new debt. A note must actually play.

### Dry run (composition + `apps.sonata.**`)

`deriveBrowserHostGraph` reports 26 unserved declarations; `browser-host:contributions-covered` 6 non-portable contributors. All come from a handful of server barrels:

| Barrel | What keeps it off the worker | Fix |
|---|---|---|
| `sonata/sources/midi/server` | `node:crypto` hash, `Bun.file(att.diskPath)`, covers' disk cache | `sha256Hex`-style bytes hash from `packages/string-hash`, `AttachmentBlobs.read`; covers over data-files |
| `sonata/covers/server` | `Bun.file`/`rename` cover cache in `cache/sonata-covers` | a `defineFileRoot` over the same data dir (data-files: disk on desktop, memory in the worker); `FileRootLocation` in a new `covers/machine` |
| `sonata/sources/musicxml/server` | same as midi | same |
| `sonata/sources/midi/folders/server` | watched folders (disk, watcher, jobs) | `server/` keeps the config registration; watcher, jobs, warm-up, status values and recheck → `machine/`; `sonata.midi-folders.status` / `.song-count` / recheck declared `needsMachine` ("Watching MIDI folders") |
| `sonata/sources/ultimate-guitar/server` | `ug-client` (UG private API, `node:crypto`) | search + tab values `needsMachine` ("Searching Ultimate Guitar"), served from `machine/`; songs collection, create/update endpoints, `ugTabSaved`, Expose stay portable |
| `…/ultimate-guitar/alignment/server` | supervised job, audio analysis, yt-dlp | rows collection + Expose portable; job, trigger, the five endpoints → `machine/`, endpoints `needsMachine` ("Aligning a sheet to a video") |
| `infra/audio-analysis/server` | files, python, flock | its config registration stays in `server/`; the rest → `machine/` (may drop out of scope once alignment's job moves) |
| `infra/deps/server` | on-demand installs | expected to leave scope with audio-analysis; else `deps.states` / install / remove `needsMachine` |
| `sonata/transcription` | launches an agent in a scratch workspace | excluded from the demo composition, exactly as Sonata's own app composition does (`!apps.sonata.transcription.**`); also `!apps.sonata.sources.midi.file-preview.**` (adapter into the file viewer, absent here) |
| raw `/api/asset-mirror` | piano + soundfont `voices.ts` call `assetMirrorUrl` | see B |

## A. Composition

`agent-manager-demo` gains `apps.sonata.**`, `!apps.sonata.transcription.**`, `!apps.sonata.sources.midi.file-preview.**` (in `plugin-meta/composition/core/config.ts` and the committed origin). It still only subtracts from what Sonata ships.

## B. Samples: the asset mirror on every host (closes xpv8t1)

A note cannot play while the mirror is machine-only. The mirror's routes become portable:

- `infra/asset-mirror/server` declares a file root over its data dir (`cache/asset-mirror`) and serves both routes through `rawEndpointHandler`: validate segments, look up the registry, read `relPath(id, …)`; on a miss `fetch(<remote>/<encoded>)`, write, serve. `needsMachine` is dropped from `getMirroredFile` / `getMirroredNestedFile`. `machine/` keeps only `FileRootLocation` (the disk, so prewarm/seed-cache still populate the same files). Desktop behaviour unchanged (same dir, same files).
- In the worker the root is memory: a sample is fetched from the mirror's declared remote (CORS-enabled public CDNs — what smplr does by default on any site) once per session. **Caveat for the homepage exit criterion ("no request leaves the browser")**: samples come from the public CDN; bundling or a website-hosted copy is a later decision.
- Web: smplr accepts a `storage: { fetch(url) }`. A new endpoints/web primitive `assetFetchOver(transport, base)` / `useAssetFetch` answers `{ kind: "ready", base, fetch }` (fetch goes through the transport, so the worker answers it) or `unavailable`. Instrument contributions' `createVoices(ctx, destination, assets)` receive an `AssetResolver` from the engine (built from `useTransport`); the piano and soundfont resolve `assetMirrorBase(id)` through it and hand smplr the storage. `sharedSampleLoader(ctx, storage)`. `assetMirrorUrl` / `ASSET_MIRROR_PREFIX` are deleted once nothing reads them.

## C. Fixture writer + demo data

- New `apps/sonata/plugins/fixtures`: `core` — `SongFixture` (a chord-grid song, or a MIDI song as bytes + meta), ids the caller's; `server` (portable) — `writeSongFixtures` through the real write paths (chord-grid's create, midi's `createMidiSongFromAttachment` after `createAttachment`).
- Lumen `core/internal/songs.ts`: two demo songs (ids carry `demo`), written in `bin/seed.ts` then `settleJobQueue()`. MIDI starters seed themselves through midi's own `onReady`, as on a fresh install.
- `bin/browser-host.test.ts`: assert the songs and an asset-mirror read through the booted graph.

## D. Verification

- `./equin build` (guard green, no new exemptions), `./equin check`.
- Lumen boot test; e2e `no-leak`, `app-switch`, `prototypes-in-demo`; new `apps/demo/e2e/sonata-in-demo.ts`: launcher → Sonata, open a seeded song, play a note (keyboard), assert the sample loads through the worker (no `/api` request to the page origin), no console error.
- Desktop smoke on my build: Sonata opens a song, piano sounds (samples via `/api/asset-mirror`), covers render.
- Sonnet review agents on `git diff $(git merge-base HEAD main)`.

## Outcome (2026-11-04)

All of A–D landed; the coverage guard is green with no new debt exemptions. The asset mirror's existing release-bundle exemption moved with its code into `asset-mirror/bundle`.

- **Server splits** (computer-bound code to `machine/`, needsMachine where only the desktop answers):
  - `midi` and `musicxml`: `node:crypto` became `createSha256` (same digest). `Bun.file` became the new `readAttachmentBytes` in attachments.
  - `covers`: a `scoreCoverFiles` data-files root.
  - `midi/folders`: the config and the song count stay portable. Status and recheck are `needsMachine`, "Watching MIDI folders".
  - `ultimate-guitar`: the tab and search values are `needsMachine`, "Reading Ultimate Guitar".
  - `alignment`: rows and Expose stay portable. The five endpoints are `needsMachine`, "Aligning a sheet to a recording".
  - `audio-analysis`: only its config is portable.
  - `deps`: the states value and install/remove are `needsMachine`, "Installing dependencies".
  - Debt exemptions deleted: midi, musicxml, covers, folders, audio-analysis, ultimate-guitar.
- **Samples:** the asset mirror is portable over `assetMirrorFiles`, a data-files root. On the desktop it is the same disk cache as before; in the worker it is memory, fetched from the instrument's CDN once per session.
  - New `assetFetchOver` in endpoints/web: an asset's base plus a fetch over the transport, for a library that takes a fetch hook.
  - `AssetUrl` gains `fetch-only` in place of a throw. The emoji picker treats it as not available.
  - Instruments get `InstrumentAssets` in `createVoices`. smplr loads through `storage`, with one shared loader per context and sample source.
  - `assetMirrorUrl` and `ASSET_MIRROR_PREFIX` are deleted. That closes task-1793668424-xpv8t1.
- **Covers leak found in /demo and fixed:**
  - The library's MIDI and MusicXML covers used `endpointPath` as an `<img src>`, so they loaded from the page's server. The coverage guard did not see it; filed as task-1793817984-v5eya0.
  - Covers now hand an `AssetPath`. A new `asset` arm of data-view's `CoverContent` loads it over the transport (via `useAssetSrc`).
- **Data:**
  - New `apps/sonata/fixtures`: `SongFixture`, written by `writeSongFixtures` through the chord-grid create write.
  - Chord-grid's `compile` and `parseGrid` moved to its `core/`, so the writer measures a grid exactly as the editor does.
  - Lumen seeds two chord grids ("Lumen theme", "Night mode"). The MIDI starters seed themselves through midi's `onReady`, as on a fresh install.
- **Composition:** `apps.sonata.**`, minus `transcription` and `midi.file-preview`, as Sonata's own app ships it.

Verification:
- e2e: `sonata-in-demo` 15/15 (new: launcher → Sonata → library → song → two notes start sampled voices, samples through the worker, no leak), `no-leak` 31/31, `app-switch` 24/24, `prototypes-in-demo` 27/27.
- The lumen boot test passes, including the new Sonata assertions (songs, a worker-drawn cover, the mirror route, recheck refused).
- Unit tests of the touched plugins pass.
- Desktop smoke: covers are served by the page's server; samples come through `/api/asset-mirror` from the disk cache, all 200; a note sounds.
- Two Sonnet reviews:
  - Fixed: the shared loader was bound to one source's storage; a failed asset cover now shows; `fetch` is async; a cached directory answers 404; the boot test asserted exact rows; import order.

Open:
- In the demo, samples come from public CDNs, which affects the homepage criterion "no request leaves the browser". Bundling them, or hosting them on the website, is a later decision.
- The coverage guard is blind to a GET route's path used as a URL (task-1793817984-v5eya0).
