# Sonata: per-track instruments that actually affect playback

## Context

In the Sonata player's **Tracks** panel each track shows its instrument as a
read-only hint (`"Flute · 312 notes"`), but playback routes **every** track
through one global instrument (the single sampled piano). The audio scheduler
flattens all tracks into one time-sorted note list and calls one
`voices.schedule(note)`; the `AudioPanel` holds one `activeInstrumentId` and one
`InstrumentVoices`. There is no per-track instrument concept anywhere, so a
flute, an oboe, and a trumpet in the same score all sound as piano.

**Goal:** make per-track instrument selection real — each track sounds with its
own timbre, multiple distinct timbres playing simultaneously.

**Decisions (confirmed with user):**
- **Timbre source:** General MIDI soundfont via smplr's `Soundfont`, served
  same-origin through the existing **asset-mirror** primitive (offline after
  first warm-up), exactly like the piano's samples today.
- **Default mapping:** each track auto-maps to the instrument matching its MIDI
  instrument program, with a per-track manual override.
- **Global picker:** removed — instrument selection becomes purely per-track,
  in the Tracks panel.

## Architecture overview

Three layers change, each staying within its plugin's responsibility:

1. **Registry — many timbres.** A new instrument sub-plugin contributes the full
   GM instrument set (programs 1–127) as `Sonata.Instrument` contributions, each
   a `smplr` `Soundfont` voice manager bound to one GM patch. The existing piano
   stays as GM program 0 + the default fallback. The `contributions: []` array
   lets one plugin register many entries (verified against the piano barrel).

2. **Resolution + persistence — per track.** `track-mixer` gains an `instrument`
   override column (mirroring `color`/`muted`/`hidden`) and resolves each
   track's effective instrument id: `override ?? gmProgram match ?? default`. It
   exposes `useTrackInstrumentMap()` and a per-track picker in the panel.

3. **Routing — per voice.** The scheduler resolves a track's voices per note;
   `AudioPanel` maintains one `InstrumentVoices` per *distinct in-use* instrument
   id and routes each note to its track's manager.

Collection-consumer separation holds: the engine and track-mixer only ever touch
the generic `Sonata.Instrument.useContributions()` API — never the soundfont
plugin by name. The GM table lives entirely inside the soundfont plugin.

---

## Layer 1 — Multi-timbre instrument registry (new sub-plugin)

New sub-plugin: `plugins/apps/plugins/sonata/plugins/audio/plugins/soundfont/`,
sibling to `audio/plugins/piano/`. Discovered automatically by build codegen
(`web.generated.ts` / `server.generated.ts`) — no manual registration edit.

Files (mirror the piano plugin's shape byte-for-byte):

- **`shared/mirror.ts`** — `SOUNDFONT_MIRROR_ID = "gm-soundfont"` and
  `SOUNDFONT_REMOTE_BASE` = smplr's soundfont CDN base. ⚠️ **Verify the exact
  base URL + file-naming scheme against the installed `smplr@0.26`** (see
  "smplr API verification" below) before finalizing.
- **`web/gm.ts`** — the canonical GM table: 128 entries
  `{ program, name, gleitz, family }` (gleitz = soundfont file slug e.g.
  `acoustic_grand_piano`, family = one of the 16 GM families) plus a
  `family → react-icons/md icon` map. Plugin-private data; owns all GM knowledge.
- **`web/voices.ts`** — `createSoundfontVoices(ctx, destination, gleitzName)`:
  wraps `smplr` `Soundfont` into `InstrumentVoices`, copying the piano's
  `voices.ts` contract exactly (`loaded`, `schedule` → `sf.start({note,velocity,
  time,duration})`, `allOff` → `sf.stop()` + `sf.scheduler.stop()`, `dispose`
  with the `disposed` no-op guard). Routes sample fetches through the
  asset-mirror via the `Soundfont` URL option (`nameToUrl`/`baseUrl` — confirm).
- **`web/index.ts`** — default-export `PluginDefinition` whose `contributions`
  maps the GM table (programs **1–127**) to `Sonata.Instrument({ id:
  "sf:"+program, label: name, icon, gmProgram: program, group: family,
  createVoices: (c,d) => createSoundfontVoices(c,d,gleitz) })`.
- **`server/index.ts`** — `defineAssetMirror({ id: SOUNDFONT_MIRROR_ID,
  remoteBaseUrl: SOUNDFONT_REMOTE_BASE })` (copy `piano/server/index.ts`).
- **`package.json`** (`"smplr": "^0.26.0"`) + **`CLAUDE.md`** (prose only; build
  appends the autogen reference block).

**Slot shape additions** in
`plugins/apps/plugins/sonata/plugins/shell/web/slots.ts` (`Sonata.Instrument`),
all optional + generic (no contributor naming):
- `gmProgram?: number` — the GM patch this timbre represents (auto-map key).
- `group?: string` — picker grouping label (GM family).
- `default?: boolean` — the fallback for tracks with no program/override.

**Piano contribution** (`audio/plugins/piano/web/index.ts`): add
`gmProgram: 0`, `group: "Piano"`, `default: true`. (Soundfont covers 1–127, so
no program overlap — auto-map is unambiguous, and the premium sampled piano wins
GM program 0 and the hint-less fallback.)

---

## Layer 2 — Per-track resolution + persistence (`track-mixer`)

Mechanical mirror of the existing `color`/`muted`/`hidden` flow. `instrument` is
nullable text; **null = "auto" (derive from MIDI program / default)**.

- **`server/internal/tables.ts`** — add `instrument: text("instrument")` to
  `_trackView` (nullable, no default).
- **`shared/resources.ts`** — add `instrument: z.string().nullable()` to
  `TrackViewRowSchema`.
- **`server/internal/resource.ts`** — add `instrument: r.instrument` to the
  loader's `.map(...)` projection. ⚠️ Easy to miss — an unprojected required
  field makes every row fail zod and the rollup silently empties (see
  `[[notifications-loader-explicit-projection]]`). Schema field is
  `.nullable()`, **not** `.optional().default()` (live-state constraint,
  `[[resource-schema-no-optional-default]]`).
- **`shared/endpoints.ts`** — add `instrument: z.string().nullable().optional()`
  to the `upsertTrackView` body.
- **`server/internal/routes.ts`** — add
  `if (body.instrument !== undefined) set.instrument = body.instrument;` and
  `instrument: body.instrument ?? null` in the insert `.values`.
- **`web/actions.ts`** — add `setTrackInstrument(songId, trackId, id|null)`
  (fire-and-forget `void fetchEndpoint`).
- **`web/hooks.ts`** — `TrackMixerEntry` gains `instrumentId: string` (resolved)
  and `instrumentLabel: string`. Resolution in `useTrackMixerEntries`, reading
  `Sonata.Instrument.useContributions()` (generic API):
  1. `row?.instrument` if set and still a valid registered id, else
  2. `contributions.find(c => c.gmProgram === track.gmProgram)?.id`, else
  3. `contributions.find(c => c.default)?.id ?? contributions[0]?.id`.
  Add `useTrackInstrumentMap(): Map<trackId, instrumentId>` (resolved),
  following the existing `useMutedTrackIds`/`useTrackColorMap` pattern.
  `customized` already keys off row existence — instrument override included.
- **`web/components/track-mixer-panel.tsx`** — replace the read-only
  `${instrument} ·` subtitle with a functional picker button (resolved label),
  opening an `InlinePopover` containing a `SearchInput`
  (`@plugins/primitives/.../search/web`) + a list of contributions grouped by
  `group`, each row a `Row` primitive. Selecting calls `setTrackInstrument`;
  a "Reset to auto" entry clears the override (sets `instrument: null`). Note
  count stays.

**Score metadata** — capture the GM program so resolution has a key:
- `plugins/apps/plugins/sonata/plugins/score/core/types.ts` — add
  `gmProgram?: number` to `TrackMeta` (alongside `instrumentHint`).
- `plugins/apps/plugins/sonata/plugins/sources/plugins/midi/web/compile.ts` —
  set `...(track.instrument.number != null ? { gmProgram: track.instrument.number } : {})`.
  Chord-grid tracks carry none → fall to the default. (Percussion tracks —
  `track.instrument.percussion` / channel 10 — are out of scope; they fall to
  the default piano. Noted as a known limitation.)

---

## Layer 3 — Per-track audio routing (`audio/engine`)

**`audio/plugins/engine/web/scheduler.ts`** — change the `voices` parameter to a
resolver and keep each note's `track` through the pending map:

```ts
startScheduling(score, fromBeat, audioAnchor,
  resolveVoices: (trackId: string) => InstrumentVoices | undefined, ctx)
```
In the pending `.map`, keep `track: n.track`; in `pump`,
`resolveVoices(note.track)?.schedule(note)`. The look-ahead/refill loop is
unchanged. (Notes whose track has no manager are skipped — but resolution always
yields a registered id, so this only guards transient gaps.)

**`audio/plugins/engine/web/components/audio-panel.tsx`** — the substantive
rewrite:
- Drop the global `activeInstrumentId` state, the `SegmentedControl` picker, and
  the single-`voices` effect.
- Import `useTrackInstrumentMap` (from `track-mixer/web`, already a cross-plugin
  consumer here via `useMutedTrackIds`).
- Compute the **in-use instrument id set** = distinct resolved ids over the
  current (audible) tracks.
- Maintain `managersRef: Map<instrumentId, InstrumentVoices>`, reconciled in an
  effect keyed on the in-use set: `createVoices(ctx, master)` for newly-needed
  ids, `dispose()` for no-longer-needed ids. One manager is shared by all tracks
  on the same instrument (muting already drops notes upstream, so sharing is
  safe).
- `resolveVoices(trackId)` = `managers.get(trackInstrumentMap.get(trackId))`.
- Scheduling effect: `await Promise.all([...managers].map(m => m.loaded))` then
  `startScheduling(audibleScore, fromBeat, anchor, resolveVoices, ctx)`; on
  cleanup/stop call `allOff()` on **every** manager.
- Aggregate load status: "Loading…" until all in-use managers resolve, error if
  any rejects. The panel keeps only the volume slider + status line (picker is
  gone).

The `audibleScore` mute-filter, the AudioContext/master-gain ownership, the
clock registration, and the anchor-on-play transport semantics are all unchanged.

---

## smplr `Soundfont` API verification (do first, in implementation)

`node_modules` is not installed in this worktree; `bun install` runs during
`./equin build`. The one genuinely uncertain detail is `Soundfont`'s
constructor options. After the first build (or `bun install`), confirm against
`node_modules/smplr/dist/*.d.ts`:
- option name for output routing (`destination`) and base-URL / `nameToUrl`
  override used to point at the asset-mirror,
- the remote base URL + file-naming (`<kit>/<name>-<format>.js`) so
  `SOUNDFONT_REMOTE_BASE` and the mirror path line up,
- `ready`/`load`, `start({note,velocity,time,duration})`, `stop()`,
  `scheduler.stop()`, `dispose()` parity with the piano wrapper.
Adjust `shared/mirror.ts` + `web/voices.ts` accordingly. **Stop and surface if
the API differs materially** rather than guessing.

---

## Files to change (summary)

New plugin `audio/plugins/soundfont/`: `shared/mirror.ts`, `web/gm.ts`,
`web/voices.ts`, `web/index.ts`, `server/index.ts`, `package.json`, `CLAUDE.md`.

Edited:
- `shell/web/slots.ts` — `Sonata.Instrument` += `gmProgram?`, `group?`, `default?`.
- `audio/plugins/piano/web/index.ts` — piano declares `gmProgram:0`, `group`, `default`.
- `score/core/types.ts` — `TrackMeta.gmProgram?`.
- `sources/plugins/midi/web/compile.ts` — populate `gmProgram`.
- `track-mixer/server/internal/tables.ts` — `instrument` column.
- `track-mixer/shared/resources.ts` — schema += `instrument`.
- `track-mixer/server/internal/resource.ts` — loader projection += `instrument`.
- `track-mixer/shared/endpoints.ts` — upsert body += `instrument`.
- `track-mixer/server/internal/routes.ts` — upsert set/values += `instrument`.
- `track-mixer/web/actions.ts` — `setTrackInstrument`.
- `track-mixer/web/hooks.ts` — resolution + `useTrackInstrumentMap`, entry fields.
- `track-mixer/web/components/track-mixer-panel.tsx` — per-track picker.
- `track-mixer/CLAUDE.md` — document the instrument override.
- `audio/plugins/engine/web/scheduler.ts` — `resolveVoices` routing.
- `audio/plugins/engine/web/components/audio-panel.tsx` — multi-manager rewrite,
  drop global picker.
- `audio/plugins/engine/CLAUDE.md` — update (no longer hosts a picker).

DB migration for the `instrument` column is generated by `./equin build`
(never run `drizzle-kit` manually); commit the generated file.

---

## Verification

1. `./equin build`; confirm the generated migration adds the `instrument`
   column and the build/checks pass (`migrations-in-sync`, `eslint`,
   `plugin-boundaries`, `plugins-doc-in-sync`, `facets:render-complete`).
2. Open `http://att-1780852832-rdt8.localhost:9000` → Sonata. Load a
   multi-instrument GM MIDI starter (e.g. one with flute/oboe/trumpet/strings).
3. **Auto-map:** each track's picker shows the instrument matching its MIDI
   program without any manual action. Press play — tracks sound with *distinct*
   timbres simultaneously (verify by muting all but one track at a time).
4. **Override:** change one track's instrument via the picker; playback that
   track immediately switches timbre. "Reset to auto" reverts to the MIDI-derived
   instrument. Reload the page — the override persists (DB-backed live-state).
5. **Offline-after-warmup:** first play of each instrument fetches its samples
   through `/api/asset-mirror/gm-soundfont/…` (same-origin); subsequent plays
   need no external network (mirror cache).
6. Scripted check with `e2e/screenshot.mjs`: open the player, click a track's
   instrument picker, select a different instrument, confirm via
   `query_db` that a `sonata_track_view` row has the `instrument` set, and that
   audio status reaches "Ready".
7. Regression: mute/hide/color per track still work; seek/pause/resume still
   anchor correctly; a single-track score still plays.
```
