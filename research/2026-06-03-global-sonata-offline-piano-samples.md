# Sonata acoustic piano — offline, no CDN

**Date:** 2026-06-03
**Status:** Plan — awaiting approval

## Context

The Sonata acoustic piano (`audio/piano`, smplr `SplendidGrandPiano`) streams its
226 samples from smplr's default remote CDN
(`https://smpldsnds.github.io/sfzinstruments-splendid-grand-piano/samples`) at
runtime. With no network the piano never sounds — unacceptable for a self-hosted
app. Today `voices.ts:29` calls `SplendidGrandPiano(ctx, { destination })` with
no `baseUrl`, so smplr uses the CDN.

**Goal:** the piano produces sound without depending on an external CDN at
runtime, **without committing ~19 MB of binary samples to git**.

**Decisions locked with the user:**
- **Cache layer:** a generic *server-side disk mirror* (not browser Cache API).
  The browser only ever talks to the local server; the cache is shared across
  all worktrees (one download per machine).
- **Warm-up:** *lazy on first playback* (no prefetch job). The first piano load
  while online populates the cache; everything after is offline.
- Samples are **not** committed; they live in `~/.singularity/`.

## Approach

Build a **generic server-side "asset mirror" primitive** (`infra/asset-mirror`):
a plugin declares a remote asset source; the framework lazily downloads each
file from the source on first request, caches it to `~/.singularity/`, and
serves it same-origin thereafter. The piano declares one mirror for the splendid
grand piano CDN and points smplr's `baseUrl` at the local mirror endpoint.

This honors the "build the primitive that makes future cases trivial" rule (any
plugin can mirror remote fonts/wasm/audio) and the collection-consumer rule (the
mirror route never names the piano — it reads a generic registry).

### Key facts verified against smplr@0.26 source (`smplr/dist/index.mjs`)

- smplr builds each URL as `` `${baseUrl}/${sampleName}.${format}` `` and, inside
  `loadAudioBuffer`, **pre-encodes** `#`→`%23` and ` `→`%20` *before* calling
  `storage.fetch`. So the mirror receives well-formed paths
  (`/api/asset-mirror/splendid-grand-piano/PP%20C%231.ogg`). **No custom smplr
  `storage` is needed — only `baseUrl`.**
- Format is auto-selected client-side from `formats` (default `["ogg","m4a"]`):
  ogg on Chromium/Firefox, m4a on Safari. The mirror fetches **on demand**, so it
  naturally serves whatever the browser actually requests — all browsers work,
  and only the used format is cached. Keep smplr's default `formats`.
- **smplr swallows per-sample failures**: `if (response.status !== 200) {
  console.warn(...); return; }`, and `loadProgress.loaded` counts *processed*,
  not *succeeded*. So `piano.ready` resolving does **not** mean samples loaded.
  The fail-loudly story therefore lives in the **mirror** (loud 502 + server log
  on cache-miss + CDN-unreachable) and the browser console — not in expecting
  `ready` to reject. (Documented as a caveat below.)

## Implementation

### 1. New primitive: `plugins/infra/plugins/asset-mirror/`

Mirror the `Registration` pattern of `defineJob`
(`plugins/infra/plugins/jobs/server/internal/registry.ts`): a `register()` token
writes into a module-level `Map`; the framework calls `.register()` in the
register phase; the route handler reads the Map. Binary serving mirrors the
attachments precedent (`plugins/infra/plugins/attachments/server/internal/handle-get.ts`).

**`core/index.ts`** (browser-safe; public API)
```ts
export const ASSET_MIRROR_PREFIX = "/api/asset-mirror";
/** Same-origin base URL for a registered mirror's files. */
export function assetMirrorUrl(id: string): string {
  return `${ASSET_MIRROR_PREFIX}/${id}`;
}
```

**`server/index.ts`** (default-export plugin)
- `export function defineAssetMirror({ id, remoteBaseUrl }): Registration` →
  `{ register() { registry.set(id, remoteBaseUrl); } }`, where `registry` is a
  module-level `Map<string, string>` in `server/internal/registry.ts`.
- `httpRoutes: { "GET /api/asset-mirror/:id/:file": handleMirror }` (single
  generic route; `:file` is one trailing segment — sample names contain no `/`).

**`server/internal/handle-mirror.ts`** (`HttpHandler`):
```
1. remoteBase = registry.get(params.id); if (!remoteBase) → 404 (unknown mirror)
2. name = decodeURIComponent(params.file)               // "PP C#1.ogg"
   reject if name contains "/" or ".." → 400 (path-traversal guard)
3. diskPath = join(SINGULARITY_DIR, "asset-mirror", id, name)
4. if exists(diskPath) → stream Bun.file(diskPath) with content-type + cache hdrs
5. else fetch(`${remoteBase}/${encodeURIComponent(name)}`)   // re-encode for CDN
     - !res.ok → console.error(...) + 502  (FAIL LOUDLY; do not write)
     - ok → atomic write (tmp file + rename) to diskPath, then stream
```
- Content-type: small ext→MIME map (`.ogg`→`audio/ogg`, `.m4a`→`audio/mp4`),
  fallback `application/octet-stream`.
- Response headers: `cache-control: public, max-age=31536000, immutable`
  (samples are immutable; lets the browser skip re-revalidation).
- `SINGULARITY_DIR` from `@plugins/infra/plugins/paths/server`
  (machine-wide, shared across worktrees → one download per machine).
- **Optional refinement** (note, don't block): an in-flight `Map<key, Promise>`
  to coalesce the ~226 concurrent first-load requests, and a modest concurrency
  cap to be polite to the CDN. Ship the simple atomic-write version first
  (concurrent writes to the same file are last-rename-wins; correct).
- Reachable from the browser at `/api/asset-mirror/...` (gateway proxies
  `/api/*` to the Bun backend unchanged — `gateway/proxy.go:347`).

Add `package.json` and `CLAUDE.md` for the new plugin.

### 2. Piano plugin changes (`plugins/apps/plugins/sonata/plugins/audio/plugins/piano/`)

**`shared/mirror.ts`** (NEW — plugin-private DRY shared by web + server)
```ts
export const PIANO_MIRROR_ID = "splendid-grand-piano";
export const PIANO_REMOTE_BASE =
  "https://smpldsnds.github.io/sfzinstruments-splendid-grand-piano/samples";
```

**`server/index.ts`** (NEW — first server barrel for this plugin; auto-collected
by the server registry codegen on `./equin build`)
```ts
import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { defineAssetMirror } from "@plugins/infra/plugins/asset-mirror/server";
import { PIANO_MIRROR_ID, PIANO_REMOTE_BASE } from "../shared/mirror";

export default {
  register: [defineAssetMirror({ id: PIANO_MIRROR_ID, remoteBaseUrl: PIANO_REMOTE_BASE })],
} satisfies ServerPluginDefinition;
```

**`web/voices.ts`** — point smplr at the local mirror; refresh the doc comment.
```ts
import { assetMirrorUrl } from "@plugins/infra/plugins/asset-mirror/core";
import { PIANO_MIRROR_ID } from "../shared/mirror";
// ...
const piano = SplendidGrandPiano(ctx, {
  destination,
  baseUrl: assetMirrorUrl(PIANO_MIRROR_ID),   // /api/asset-mirror/splendid-grand-piano
  // formats left at smplr's default ["ogg","m4a"]; the mirror serves on demand.
});
```
Replace the "needs network at runtime; offline it will not sound" paragraph with:
samples are mirrored to `~/.singularity/` on first (online) play and served
same-origin thereafter — offline-capable after one warm-up. Note the smplr
caveat: failed sample fetches are swallowed, so an offline-and-never-warmed
piano resolves `ready` but is silent (the mirror logs a loud 502 server-side).

### 3. Fail-loudly fix in the audio engine

`engine/web/components/audio-panel.tsx:105` does `void next.loaded.then(() =>
setReady(true))` with **no rejection handler** — if `ready` rejects (e.g. the
instrument JSON itself fails), the status spins "Loading…" forever and the
promise rejection floats (the repo's `no-floating-promises` lint also flags it).
Fix: add the rejection arm and an error status line.
```ts
const [loadError, setLoadError] = useState<string | null>(null);
// in the voices effect, after setReady(false):
setLoadError(null);
void next.loaded.then(
  () => { if (!cancelled) setReady(true); },
  (err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err)); },
);
```
Render `Failed to load: ${loadError}` (styled `text-destructive`) in the status
line instead of an eternal spinner. (Per the smplr caveat this won't catch
individual swallowed samples — the mirror's server-side 502 + console warnings
are the loud signal for that case.)

## Critical files

- `plugins/infra/plugins/asset-mirror/` — **new primitive** (core + server + internal handler + package.json + CLAUDE.md)
- `plugins/infra/plugins/jobs/server/internal/registry.ts` — `Registration` pattern to mirror (read-only ref)
- `plugins/infra/plugins/attachments/server/internal/handle-get.ts` — binary-serving precedent (read-only ref)
- `plugins/infra/plugins/paths/server` — `SINGULARITY_DIR` for the cache dir
- `plugins/apps/plugins/sonata/plugins/audio/plugins/piano/shared/mirror.ts` — **new** shared id/base
- `plugins/apps/plugins/sonata/plugins/audio/plugins/piano/server/index.ts` — **new** mirror registration
- `plugins/apps/plugins/sonata/plugins/audio/plugins/piano/web/voices.ts` — set `baseUrl`, update comment
- `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/components/audio-panel.tsx` — fail-loud rejection arm

## Verification (end-to-end)

1. `./equin build` from the worktree. Confirm the new piano `server/index.ts`
   is picked up (no server-registry codegen errors) and `./equin check` passes
   (plugin boundaries, eslint).
2. **Online path:** open `http://<worktree>.localhost:9000/sonata`, load a MIDI,
   select **Acoustic Piano**, press Play → it sounds. In DevTools Network, confirm
   sample requests go to `/api/asset-mirror/splendid-grand-piano/...` (same-origin),
   **not** to `smpldsnds.github.io`. Confirm `~/.singularity/asset-mirror/splendid-grand-piano/`
   is populated with `.ogg` files. Use `e2e/screenshot.mjs --click "Play"` to drive it.
3. **Offline path:** with the cache populated, set DevTools to **Offline** (or stop
   the machine's network), reload, press Play → still sounds, served from disk. No
   outbound CDN requests.
4. **Fail-loud path:** clear the cache dir and make the CDN unreachable (e.g.
   temporarily point `PIANO_REMOTE_BASE` at a bad host, or block network), play →
   the mirror returns **502** and logs an error server-side (visible in the Debug
   logs pane / server logs); the audio panel does not hang on a rejected `ready`.
   Restore the real base afterward.
5. **Shared-cache check:** a second worktree's piano plays offline immediately
   (the cache under `~/.singularity/` is shared — no re-download).

## Out of scope / caveats

- **Offline-and-never-warmed → silence (no UI error):** smplr swallows per-sample
  fetch failures, so a fresh install that has never been online resolves `ready`
  and plays nothing. The loud signal is the mirror's 502 + server log + browser
  console. A UI-level "samples unavailable" banner would require extending the
  `InstrumentVoices` contract with a real loaded-count / health signal — deferred.
- **Load-progress UX** ("142/226 loaded") via smplr's `onLoadProgress` is a
  possible follow-up; it needs an `InstrumentVoices` contract extension and is not
  required for the offline goal.
- First online warm-up issues ~226 parallel mirror requests; the optional
  in-flight coalescing / concurrency cap can be added if profiling shows strain.
