# Sonata — per-song "auto-detect key" toggle + key-source badge

## Context

The Sonata "Current key" readout panel (`KeyReadout`) shows the song's key but
never says **where that key came from**. A song imported from MIDI carries an
authored key signature (MIDI Meta Event 0x59), which `inferKeys` trusts and
never second-guesses. But MIDI key headers are often wrong, missing modulations,
or absent — in which case Sonata already falls back to Krumhansl–Schmuckler
auto-detection. The user has no way to (a) tell which of the two is in force, or
(b) override a bad MIDI key with auto-detection.

This change adds:
1. A **source badge** in the key-readout panel — "From MIDI" (authored) vs
   "Auto-detected" (derived).
2. A **per-song toggle** "Auto-detect key", shown only when the song carries an
   authored key. When ON, the song is treated as keyless: key inference re-runs,
   and notes/chords are **re-spelled and re-analyzed** from the inferred key
   (full-pipeline override — confirmed with user). Persisted per song in the DB.

For keyless songs (no authored key) nothing is authored to override, so no
toggle appears — just the "Auto-detected" badge.

## Key constraint & chosen seam

Key inference, spelling, and chord analysis all run in the **shell** plugin's
score pipeline (`SonataProvider` → `baseScore` useMemo). The shell is
load-bearing and imported by ~every Sonata sub-plugin, so it **cannot import a
feature plugin** (cycle). The toggle's persisted state lives in a new feature
plugin, but its value must reach the shell's pipeline.

**Seam:** a module-level store in the shell (mirroring the existing
`cursor-store.ts` / `transport-store.ts` precedent), exported from the shell
barrel. The new `key-mode` plugin imports the shell and **writes** the store; the
shell **reads** it in the `baseScore` memo. Dependency arrow stays
feature → shell, no cycle, and we avoid bloating the large `SonataContextValue`.

## Pipeline trace (existing)

`plugins/apps/plugins/sonata/plugins/shell/web/context.tsx` ~L296–311:
```ts
const merged  = mergeScores(compiled);
const keyed   = inferKeys(merged);     // theory/core — bails if authored key present
const spelled = spellScore(keyed);     // score/core — spells each note via effectiveKeyAt
const derived = analyzers.flatMap(a => a.analyze(spelled));
return mergeAnnotations(spelled, derived);
```
`spellScore` (`score/core/spelling.ts`) and the chord analyzer
(`rich/chord-analyzer`) both read the key **only** through `effectiveKeyAt` →
`collectKeyEntries`, which derives from `score.meta.key` + `type:"key"`
annotations. So stripping the authored key from the score before inference is
sufficient to make the whole downstream pipeline use the derived key.

## Implementation

### New plugin: `plugins/apps/plugins/sonata/plugins/rich/plugins/key-mode/`

Sibling to `key-readout` / `key-chip`. Template: the `playback-history` plugin
(1:1 per-song entity extension + push resource + POST setter + hook + observer).

| File | Content |
|---|---|
| `package.json` | Copy `key-readout`'s; name `@plugins/apps/plugins/sonata/plugins/rich/plugins/key-mode`. |
| `shared/resources.ts` | `KeyAutoDetectRow = { songId, enabled }`; `keyAutoDetectResource = resourceDescriptor<KeyAutoDetectRow[]>("sonata-key-auto-detect", schema, [])`. Mirror `playback-history/shared/resources.ts`. |
| `shared/endpoints.ts` | `setKeyAutoDetectEndpoint = defineEndpoint({ route: "POST /api/sonata/songs/:id/key-auto-detect", body: z.object({ enabled: z.boolean() }) })`. |
| `server/internal/tables.ts` | `songKeyAutoDetect = defineExtension(_songs, "key_auto_detect", { enabled: boolean("enabled").notNull().default(false) })` (`_songs` from `@plugins/apps/plugins/sonata/plugins/library/server`); `export const _songKeyAutoDetectExt = songKeyAutoDetect.table;` (drizzle-kit discovery). Table → `sonata_songs_ext_key_auto_detect`. |
| `server/internal/resource.ts` | Push `defineResource` loading all rows → `{ songId: r.parentId, enabled: r.enabled }`. |
| `server/internal/routes.ts` | `implement(setKeyAutoDetectEndpoint, …)` → `songKeyAutoDetect.upsert(params.id, { enabled })` then `resource.notify()`. |
| `server/index.ts` | Register resource (`Resource.Declare`), wire route, re-export handle + resource. Mirror `playback-history/server/index.ts`. |
| `web/hooks.ts` | `useKeyAutoDetectRow(songId)`: `useResource(keyAutoDetectResource)` + `.find(r => r.songId === songId)`; returns `enabled` (default `false`, `false` while pending). |
| `web/actions.ts` | `setKeyAutoDetect(songId, enabled)` → `void fetchEndpoint(setKeyAutoDetectEndpoint, …)`. Mirror `track-mixer/web/actions.ts`. |
| `web/components/key-mode-observer.tsx` | Headless `Sonata.Effect`: reads `useSonata().currentSongId` + `useKeyAutoDetectRow(currentSongId)`; in a `useEffect` keyed `[currentSongId, enabled]` writes the **shell store** `setKeyAutoDetectStore(currentSongId ? enabled : false)`. Writing `false` on null song id prevents the previous song's toggle leaking into the next. Mirror `record-play-observer.tsx`. |
| `web/index.ts` | Export `useKeyAutoDetectRow`, `setKeyAutoDetect`; default plugin contributes `Sonata.Effect({ id: "key-mode", component: KeyModeObserver })`. |
| `CLAUDE.md` | Short prose + autogen block (filled by `./equin build`). |

### Edits to existing files

1. **`shell/web/key-mode-store.ts`** *(new, inside the shell)* — module store
   mirroring `cursor-store.ts`: `getKeyAutoDetect()`, `setKeyAutoDetect(bool)`,
   `subscribeKeyAutoDetect()`, and `useKeyAutoDetect()` via `useSyncExternalStore`.
   Single boolean, default `false`.

2. **`shell/web/index.ts`** — export the four `key-mode-store` symbols alongside
   the cursor-store exports. (Rename the store's setter export to avoid clashing
   with the key-mode plugin's `setKeyAutoDetect` action, e.g. export as
   `setKeyAutoDetect` from shell and have the plugin alias on import, or name the
   store setter `setKeyAutoDetectStore`.)

3. **`shell/web/context.tsx`** — in `SonataProvider`:
   `const keyAutoDetect = useKeyAutoDetect();` then
   `const keyed = inferKeys(merged, { force: keyAutoDetect });` and add
   `keyAutoDetect` to the `baseScore` dep array (~L311). No context-value change.

4. **`theory/core/key-detect.ts`** — `inferKeys(score, opts?: { force?: boolean })`.
   When `opts.force`: build a stripped score
   `{ ...score, meta: { ...score.meta, key: undefined }, annotations: score.annotations.filter(a => !(a.type === "key" && a.source === "authored")) }`,
   skip the `hasAuthoredKey` bail, and run the existing Krumhansl inference on the
   stripped score (keep the notes-empty + confidence-floor bails). Return the
   stripped+inferred score. Update docstring.

5. **`score/core/key-context.ts`** — extend
   `KeyEntry = { beat; key; source: "authored" | "derived"; confidence?: number }`.
   In `collectKeyEntries`, store `{ key, source, confidence }` per beat
   (`meta.key` → `"authored"`; annotation → `a.source` / `a.confidence`; the
   beat-0 override semantics carry source correctly). `effectiveKeyAt` unchanged
   (reads `.key`).

6. **`rich/plugins/key-readout/web/components/key-readout.tsx`** —
   - Change the `useCursorSelector` to return the active **entry**
     (`{ key, source }`) and pass an `isEqual` comparing `key.tonic`, `key.mode`,
     `source` by value (selector mints a fresh object — required to avoid
     per-frame re-render; see `cursor-store.ts` docstring).
   - Render a badge from `source`: "From MIDI" / "Auto-detected".
   - `showToggle = entries.some(e => e.source === "authored") || keyAutoDetect`
     (in force mode the authored key is stripped from entries, so OR the live
     toggle value; keyless songs never persist the toggle, so this is
     self-consistent).
   - When `showToggle`, render a `ToggleChip`
     (`@plugins/primitives/plugins/toggle-chip/web`, already used by chord-readout)
     bound to the shell store hook `useKeyAutoDetect()` for display and
     `setKeyAutoDetect(currentSongId, next)` (key-mode action) for the write.
   - Imports: `useKeyAutoDetectRow` + `setKeyAutoDetect` from `key-mode/web`;
     `useKeyAutoDetect` (store) + `useSonata` from the shell barrel.

### Known, accepted behaviors (call out in the PR)

- **Settle on open:** the persisted toggle arrives via a push resource (async).
  An auto-detect-ON song opens showing the authored key, then flips to the
  detected key once the resource resolves — same settle as track colors /
  playback stats. Acceptable; default-OFF songs never recompose, so only a
  song explicitly turned ON and reopened settles.
- **Cursor reset on toggle:** toggling rebuilds `baseScore` by reference, and the
  existing `useEffect([baseScore])` resets the playhead to 0 and pauses. Correct
  (spelling/chords just changed under the cursor), but worth noting.
- `inferKeys` stays pure (no module-store reads) — `force` is passed in.

## Critical files

- `plugins/apps/plugins/sonata/plugins/shell/web/context.tsx`
- `plugins/apps/plugins/sonata/plugins/shell/web/cursor-store.ts` (store template)
- `plugins/apps/plugins/sonata/plugins/shell/web/index.ts`
- `plugins/apps/plugins/sonata/plugins/theory/core/key-detect.ts`
- `plugins/apps/plugins/sonata/plugins/score/core/key-context.ts`
- `plugins/apps/plugins/sonata/plugins/rich/plugins/key-readout/web/components/key-readout.tsx`
- `plugins/apps/plugins/sonata/plugins/playback-history/**` (whole-plugin template)
- `plugins/infra/plugins/entity-extensions/server` (`defineExtension`)

## Verification

1. `./equin build` (regenerates the migration for
   `sonata_songs_ext_key_auto_detect`, builds, restarts). Then
   `./equin check migrations-in-sync` + `./equin check plugin-boundaries`.
2. Open a **MIDI** song with a key header at
   `http://<worktree>.localhost:9000/sonata/song/<id>`:
   - Badge reads **From MIDI**; the "Auto-detect key" toggle is visible.
   - Flip it ON → badge flips to **Auto-detected**, the displayed key and the
     scale notes update to the Krumhansl result, and piano-roll note spellings /
     chord labels re-derive. Reload → toggle stays ON (persisted).
   - Flip OFF → reverts to the MIDI key. Verify via the MCP `query_db`:
     `SELECT * FROM sonata_songs_ext_key_auto_detect;`
3. Open a **keyless** song (MIDI without a key header, or chord-grid) → badge
   reads **Auto-detected**, **no toggle**.
4. `bun test plugins/apps/plugins/sonata/plugins/score` and
   `bun test plugins/apps/plugins/sonata/plugins/theory` (update/extend any
   `key-context` / `key-detect` tests for the new `KeyEntry` shape and `force`).
5. Scripted check with `e2e/screenshot.mjs` clicking the toggle to capture
   before/after of the readout.
