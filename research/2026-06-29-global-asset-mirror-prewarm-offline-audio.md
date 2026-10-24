# Generic asset-mirror prewarm — offline cold-start audio

> Status: implementation plan. Category: `global` (asset-mirror primitive, codegen, release CLI, launcher, sonata audio plugins).
> Deferred follow-up from [`research/2026-06-24-global-tauri-release-target.md`](./2026-06-24-global-tauri-release-target.md) → "Deferred / follow-up".

## Context

A freshly-installed release (Tauri desktop, or any self-contained web bundle) launched **offline** has no instrument audio. The `asset-mirror` primitive serves samples from `<SINGULARITY_DIR>/asset-mirror/<id>/<file>` and only downloads from the CDN on a cache **miss** — so a cold, offline cache returns 502, and the client degrades **silently** (smplr swallows the per-sample failure and still resolves `ready`, so the instrument is mute with no surfaced error). Sonata's default Splendid Grand Piano is the visible victim.

The fix: the release bundle ships a **pre-warmed** asset-mirror cache, and the launcher copies it into the app-data cache on first run. The mechanism must be **generic** — the release pipeline and the Tauri shell must contain **no app-specific warm-up logic**. *Which* files to seed is knowledge that belongs with the plugin registering the mirror, surfaced through a generic **prewarm contribution** that the release pipeline consumes for **every mirror in the composition's closure**.

Decisions locked with the user:
- **Seed both `.ogg` and `.m4a`** for the piano. smplr negotiates format by browser (`.ogg` on Chromium/Firefox, `.m4a` on Safari/WebKit — the Tauri webview is WebKit). Seeding both makes offline audio work in the desktop shell *and* a Chromium/Firefox web release. Samples are small.
- **Seed the piano *and* the default GM soundfont instrument.** The 100+ non-default soundfont instruments stay lazy/online.

## Why this shape

The codebase already has the exact primitive for "collect a contribution from each plugin, filtered to a composition's closure": the **collected-dir** pattern (`provision/`, `check/`, plus the web/server runtime registries), with composition filtering via `generateCompositionRegistry` (`COMPOSITION_RUNTIME_DIRS` in `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts:331`). A new `prewarm` collected-dir reuses that machinery verbatim — no new closure resolution, no app names in the pipeline.

The launcher copy lives in **one place** — `launch.ts` — and covers **both** targets, because the Tauri shell spawns `bundle/launch` (i.e. runs `launch.ts`) on every startup. **The Rust shell needs no change.**

## Design

### 1. asset-mirror: a generic prewarm contribution + runner

**Refactor the download primitive (reuse, don't duplicate).** Extract the fetch + atomic-write block from `handleMirror` (`plugins/infra/plugins/asset-mirror/server/internal/handle-mirror.ts:54-79`) into an exported helper:

```ts
// asset-mirror/server/internal/fetch-to-disk.ts
export async function mirrorFetchToDisk(opts: {
  remoteBaseUrl: string; file: string; diskPath: string;
}): Promise<void>  // fetch <remoteBaseUrl>/<encodeURIComponent(file)>, mkdir -p, atomic tmp+rename; throw on !ok
```
`handleMirror` calls it (writing to `<CACHE_ROOT>/<id>/<file>`); the prewarm runner calls it (writing to `<destRoot>/<id>/<file>`).

**Core (browser-safe) additions** — mirror the `provision` precedent (`plugins/framework/plugins/tooling/plugins/provision/core/`):
- `asset-mirror/core/collected-dir.ts` — `export const assetMirrorPrewarmCollectedDir = defineCollectedDir("prewarm");`
- `asset-mirror/core/prewarm.ts` — the descriptor type + factory:
  ```ts
  export interface AssetMirrorPrewarm {
    id: string;            // matches the mirror's defineAssetMirror id
    remoteBaseUrl: string; // matches the mirror's remoteBaseUrl (same shared constant)
    files: string[];       // flat filenames to pre-download, e.g. "PP C#1.ogg"
  }
  export function defineAssetMirrorPrewarm(spec: AssetMirrorPrewarm): AssetMirrorPrewarm { return spec; }
  ```
- `asset-mirror/core/index.ts` re-exports `assetMirrorPrewarmCollectedDir`, `defineAssetMirrorPrewarm`, `AssetMirrorPrewarm`, and `prewarmEntries` from the generated `./prewarm.generated` (as `provision/core/index.ts` does).

> `remoteBaseUrl` is repeated in the mirror definition and the prewarm descriptor, but both import the same constant from the plugin's `shared/mirror.ts` — the literal lives once. The descriptor is deliberately self-contained data so the release runner reads it generically without booting the server to populate the mirror registry.

**Server: the runner** — `asset-mirror/server` exports:
```ts
export async function runAssetMirrorPrewarm(opts: { destRoot: string; log?: (m: string) => void }): Promise<void>
```
It dynamically imports the **composition-filtered** entries (`../core/prewarm.composition.generated`, present only during a composition build — import dynamically and no-op if absent), runs each entry's `loader()` to get the `AssetMirrorPrewarm` descriptor, and for every `file` calls `mirrorFetchToDisk({ remoteBaseUrl, file, diskPath: join(destRoot, id, file) })`. **Fail loud:** any failed load or download aborts the release with a combined error (like `run-provisions.ts`).

**Server: the launcher seed helper** — also export from `asset-mirror/server`:
```ts
export function seedAssetMirrorCache(opts: { bundleRoot: string; dataDir: string; log?: (m: string) => void }): void
```
Recursively **copy-if-absent** every file under `<bundleRoot>/asset-mirror` into `<dataDir>/asset-mirror` (mkdir -p; skip files that already exist so a user's previously-downloaded samples are never clobbered and newly-seeded files are filled in). No-op if `<bundleRoot>/asset-mirror` is absent. Owning the `"asset-mirror"` dirname here keeps that knowledge in the primitive rather than leaking into the launcher.

### 2. codegen: make `prewarm` composition-filterable

`plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts:331` — add `"prewarm"` to `COMPOSITION_RUNTIME_DIRS`:
```ts
const COMPOSITION_RUNTIME_DIRS = new Set(["web", "server", "prewarm"]);
```
Update the adjacent comment: `prewarm` is **release-build-time only** (consumed by the release runner, never loaded by the served app), but it needs the same closure filtering as the runtime registries. This makes a composition build emit `asset-mirror/core/prewarm.composition.generated.ts` restricted to the closure, and `clearCompositionRegistries` cleans it up on plain builds — same lifecycle as the web/server filtered registries.

### 3. release CLI: prewarm step between staging and pack

`plugins/framework/plugins/cli/bin/commands/release.ts` — after Phase **[3/5]** (the `out/` tree is fully staged incl. `RELEASE.json`, `:464-475`) and before Phase **[4/5]** pack (`:503`), insert a `[3.5]` step:
```ts
console.log("\n[3.5] Pre-warming asset-mirror caches for the composition closure...");
const { runAssetMirrorPrewarm } = await import("@plugins/infra/plugins/asset-mirror/server");
await runAssetMirrorPrewarm({ destRoot: join(out, "asset-mirror"), log: console.log });
```
This bakes `out/asset-mirror/<id>/<file>` into the staged tree, so `packStagedTree` tars it into the self-extracting binary, and the Tauri branch copies it into `tauri/src-tauri/resources/bundle/asset-mirror/`. **No app-specific code in the CLI** — it runs whatever the closure's prewarm contributions declare. Generic for `--target web` and `--target tauri` alike. (Phase 1 already runs `build --composition`, which regenerates the filtered `prewarm.composition.generated.ts` the runner reads.)

### 4. launcher: copy-if-absent on first run

`plugins/infra/plugins/launcher/bin/launch.ts` — in `main()`, **after** `writeReleaseDatabaseConfig(...)` (`:86`, which `mkdirSync`s `SINGULARITY_DIR`) and **before** `bootSelfContainedApp(...)` (`:94`):
```ts
const { seedAssetMirrorCache } = await import("@plugins/infra/plugins/asset-mirror/server");
seedAssetMirrorCache({ bundleRoot, dataDir: process.env.SINGULARITY_DIR!, log: console.log });
```
Dynamic import (after env is frozen, per the file's import discipline). Source = `<bundleRoot>/asset-mirror`; dest = `<SINGULARITY_DIR>/asset-mirror`. Runs before the backend starts serving mirror requests. Covers web (`SINGULARITY_DIR = <bundleRoot>/data`) and Tauri (`SINGULARITY_DIR = <app-data>/data`) identically, because the Tauri shell runs this same binary. **No change to `tauri/src-tauri/`.** Not placed in `bootSelfContainedApp` because that is also used by ephemeral previews with a `/tmp` data dir and no bundle to seed.

### 5. The two seeds (app-specific knowledge, lives with the plugins)

**Piano** — new `plugins/apps/plugins/sonata/plugins/audio/plugins/piano/prewarm/index.ts`:
```ts
import { defineAssetMirrorPrewarm } from "@plugins/infra/plugins/asset-mirror/core";
import { PIANO_MIRROR_ID, PIANO_REMOTE_BASE } from "../shared/mirror";
const NOTES = [/* the SplendidGrandPiano sample names smplr requests */];
export default defineAssetMirrorPrewarm({
  id: PIANO_MIRROR_ID, remoteBaseUrl: PIANO_REMOTE_BASE,
  files: NOTES.flatMap((n) => [`${n}.ogg`, `${n}.m4a`]),
});
```
The sample-name list must **exactly match** what smplr requests at runtime (verify via the Network tab on one online load — see verification). Derive it from smplr's `SplendidGrandPiano` sample set / the `sfzinstruments-splendid-grand-piano` manifest; do not guess.

**Soundfont** — new `plugins/apps/plugins/sonata/plugins/audio/plugins/soundfont/prewarm/index.ts`: seed the single default GM instrument's `<gleitzName>-mp3.js` (mp3 is universal — one file). Use Sonata's actual default soundfont instrument id (look it up in the soundfont/sonata default config, don't hardcode blindly).

## Critical files

**New**
- `plugins/infra/plugins/asset-mirror/server/internal/fetch-to-disk.ts` — `mirrorFetchToDisk`.
- `plugins/infra/plugins/asset-mirror/core/collected-dir.ts` — `defineCollectedDir("prewarm")`.
- `plugins/infra/plugins/asset-mirror/core/prewarm.ts` — `AssetMirrorPrewarm` + `defineAssetMirrorPrewarm`.
- `plugins/apps/plugins/sonata/plugins/audio/plugins/piano/prewarm/index.ts` — piano seed.
- `plugins/apps/plugins/sonata/plugins/audio/plugins/soundfont/prewarm/index.ts` — soundfont seed.
- (auto-generated by `./equin build`) `asset-mirror/core/prewarm.generated.ts` + `prewarm.composition.generated.ts`.

**Modified**
- `plugins/infra/plugins/asset-mirror/server/internal/handle-mirror.ts` — call `mirrorFetchToDisk`.
- `plugins/infra/plugins/asset-mirror/server/index.ts` — export `runAssetMirrorPrewarm`, `seedAssetMirrorCache`.
- `plugins/infra/plugins/asset-mirror/core/index.ts` — re-export prewarm core + generated entries.
- `plugins/framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` — add `"prewarm"` to `COMPOSITION_RUNTIME_DIRS` (+ comment).
- `plugins/framework/plugins/cli/bin/commands/release.ts` — `[3.5]` prewarm step.
- `plugins/infra/plugins/launcher/bin/launch.ts` — `seedAssetMirrorCache` call.
- `plugins/infra/plugins/asset-mirror/CLAUDE.md` — document the prewarm contribution + that lazy-download is still the fallback.

## Verification (end to end)

1. **Build wiring:** `./equin build --composition sonata`, confirm `plugins/infra/plugins/asset-mirror/core/prewarm.composition.generated.ts` lists the piano + soundfont entries only.
2. **Sample-name correctness (the risky bit):** launch sonata online, play the piano + the default soundfont instrument, and read the Network tab — record every `/api/asset-mirror/...` filename actually requested. The piano `prewarm` `files` list must be a superset of those (both `.ogg` and `.m4a`). Adjust the seed list to match exactly.
3. **Release prewarm:** `./equin release --composition sonata --target web` → confirm the staged/extracted bundle contains `asset-mirror/splendid-grand-piano/*.ogg` + `*.m4a` and `asset-mirror/gm-soundfont/<default>-mp3.js`.
4. **Offline cold start (web bundle):** on a clean machine (no `~/.singularity`, or a fresh `SINGULARITY_DIR`) with the CDN blocked (e.g. `/etc/hosts` → `127.0.0.1 smpldsnds.github.io gleitz.github.io`), run `launch`; confirm the window plays piano audio immediately, `<SINGULARITY_DIR>/asset-mirror/...` got seeded, and the Network tab shows `/api/asset-mirror/...` `200` with **no** upstream fetch.
5. **copy-if-absent idempotence:** relaunch; confirm no re-copy and any user-downloaded extra samples are preserved.
6. **Tauri:** `./equin release --composition sonata --target tauri`, launch the `.app` offline, confirm audio works (validates the seed flows through `bundle/launch` with no Rust change).
7. **Closure filtering:** release a composition that excludes sonata; confirm **no** `asset-mirror/` dir is bundled (the prewarm runner saw an empty closure-filtered registry).
