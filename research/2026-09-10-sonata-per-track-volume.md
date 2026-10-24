# Per-track volume in the Sonata track mixer

## Context

The Tracks panel already lets you give each track of a song a color, an
instrument, a mute toggle and a hide toggle. What it cannot do is balance the
tracks against each other: mute is all-or-nothing, so making the left hand sit
behind the right hand is impossible.

The user asked for a per-track volume control. Confirmed shape:

- **Where it lives** — hovering the speaker icon expands it leftwards into a
  fader. No extra click. Clicking the speaker still mutes the track.
- **Range** — 0–200%, so a buried line can be pushed forward, not only pulled
  back. 100% is the default and the track as recorded.
- **The slider look** — extracted into a shared primitive, with the master
  volume and the metronome click-volume re-pointed at it (both currently carry
  their own copy of the same CSS).

The outcome: each track gets a real fader — a Web Audio `GainNode` of its own —
persisted per (song, track) alongside the other view state, applied live while
you drag without cutting any note that is currently sounding.

## The one design decision that shapes everything

Today the audio engine keeps **one voice manager per distinct instrument**,
shared by every track that resolves to it, all feeding the single master gain.
That sharing is exactly what makes a per-track fader impossible: a shared
instrument has one output node, so there is no place to put a per-track gain.

So the engine changes to **one channel strip per track**: a dedicated `GainNode`
(the fader) connected to master, feeding a dedicated voice manager created with
`createVoices(ctx, trackGain)`. Two tracks on the same instrument no longer
share anything.

The cost is that two piano tracks now build two `SplendidGrandPiano` instances,
which would fetch and decode the whole sample set twice — and a two-hand piano
score is the single most common shape in this app. That is paid for by passing
every smplr instrument a **shared `SampleLoader`** (see step 5): smplr caches
decoded buffers by resolved URL inside the loader, so N instances of one
instrument cost one download and one decode.

Rejected alternative: scaling each note's MIDI velocity instead of adding a gain
node. It keeps the shared managers and needs no new plumbing, but velocity is
not volume — on a velocity-layered instrument it swaps the sample layer, so a
fader would change the timbre, and the mapping depends on smplr's internal
velocity→gain curve, which nothing would hold us to.

---

## 1. New primitive — `primitives/css/plugins/slider`

The thin-track slider look (3px track, 11px thumb, themed fill) exists twice
today as byte-identical copied CSS:
`audio/plugins/engine/web/components/volume-control.css` and
`audio/plugins/metronome/web/components/metronome-button.css`. The track fader
would be the third copy.

New leaf plugin, shaped like its siblings `css/plugins/switch` and
`css/plugins/toggle-chip` (package.json · CLAUDE.md · `web/index.ts` ·
`web/internal/slider.tsx` · `web/internal/slider.css`, `contributions: []`):

```tsx
<Slider
  value={volume}
  min={0}
  max={2}
  step={0.01}
  detent={1}                    // home position: a tick, and drags snap to it
  onValueChange={setVolume}
  aria-label="Track volume"
  className="w-24"              // sizing only
/>
```

Two things the primitive owns that the copies got away with by accident:

- **The fill normalization.** Both copies write `style={{"--fill": value * 100}}`,
  which is only correct because their range happens to be 0–1. The primitive
  computes `(value - min) / (max - min) * 100`, so a non-0–1 range (like this
  one) cannot silently paint the wrong fill.
- **`detent`** — the tick mark at a value, and snapping to it when a drag lands
  within a couple of steps. This is what makes 100% findable on a fader that can
  boost past it, and it keeps the raw positioning out of feature code.

Then re-point both existing call sites at `<Slider>` and delete
`volume-control.css` plus the slider rules in `metronome-button.css`.

**Files:** `plugins/primitives/plugins/css/plugins/slider/**` (new) ·
`plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/components/volume-control.tsx` ·
`plugins/apps/plugins/sonata/plugins/audio/plugins/metronome/web/components/metronome-button.tsx`

## 2. Persist the level — `track-mixer`

`volume` joins the existing per-(song, track) row. It is a plain linear gain
multiplier: `1` is unity, `0` is silent, `2` is +6 dB.

- `core/schemas.ts` — add `volume: floatField({ min: 0, max: 2, default: 1 })`
  to `trackViewFields` (`floatField` from
  `@plugins/fields/plugins/float/plugins/config/core`; it already has a server
  storage contribution mapping it to `double precision`). The table and the wire
  schema both derive from this record, so nothing else needs restating.
- `server/internal/tables.ts` — `columns: { volume: { default: 1 } }`, beside the
  existing `muted` / `hidden` defaults, so an absent row reads as unity.
- `shared/endpoints.ts` — `volume: z.number().min(0).max(2).optional()` on the
  partial-patch upsert body.
- `server/internal/routes.ts` — one more `if (body.volume !== undefined)` line in
  the patch set, and `volume: body.volume ?? 1` in the insert values.
- `web/actions.ts` — `setTrackVolume(songId, trackId, volume)`, fire-and-forget
  like its siblings.
- `web/hooks.ts` — `volume: row?.volume ?? 1` on `TrackMixerEntry`, plus
  `useTrackVolumeMap(): Map<string, number>` derived from it exactly like
  `useTrackInstrumentMap`. Export it from `web/index.ts`.

The migration is generated by `./equin build`; never by hand.

**While here — a bug this change would otherwise make worse.** `TrackMixerEntry`
has one `customized` flag, computed as `row !== undefined`, and the panel feeds
it to the instrument picker as "does this track have an instrument override?".
So muting a track already makes the picker stop showing "Auto" and mark the
resolved instrument as explicitly chosen. Touching a fader would do the same.
Split it: `instrumentCustomized: row?.instrument != null` for the picker, and
keep `customized` (any override at all) for the reset button's enabled state.

## 3. The fader UI — `track-mixer`

The row keeps its shape; the mute button becomes the trigger of a
`FloatingAction`
(`@plugins/primitives/plugins/overlay/plugins/floating-action/web`), which is
the primitive for exactly this — hover/focus/touch disclosure with a grace
delay, no re-entry dead zone, and a stable hitbox that cures open/close flicker.

```tsx
<FloatingAction
  className="relative size-6 z-popover"   // wrapper reserves the collapsed footprint
  variant="ghost"
  direction="row"
  triggerAt="end"                          // speaker on the right, fader revealed left
  anchor="top-right"
  align="center"
  gap="xs"
  pad="xs"
  panelClassName={cn("max-w-6 group-data-open/fa:max-w-48")}
  trigger={<IconButton icon={LevelIcon} label={…} onClick={toggleMute} />}
>
  <FloatingActionFadeIn>
    <Line>
      <Text variant="caption">{Math.round(volume * 100)}%</Text>
      <Slider … />
    </Line>
  </FloatingActionFadeIn>
</FloatingAction>
```

The speaker icon reflects the level rather than only the mute flag — muted →
`MdVolumeOff` (destructive tint), 0 → `MdVolumeMute`, below unity →
`MdVolumeDown`, at or above → `MdVolumeUp` — so a track dragged to silence does
not show an "audible" speaker. Clicking still toggles mute, which stays a
separate concept (see step 4).

**Writing while dragging.** A drag fires a change event per frame; one HTTP
upsert per frame would hammer the DB and the live-state broadcast. New local
hook `web/use-track-fader.ts`:

- the thumb follows the pointer from local draft state, so it is never laggy;
- the persisted write is **throttled leading + trailing at ~100 ms**, with a
  flush on pointer-up / key-up — a trailing-only debounce would never fire
  during a continuous drag, which is the classic version of this bug;
- the draft is held until the resource echoes it back, so the row never jumps
  to a stale value between release and the write landing, and a failed write
  leaves the user's position on screen rather than reverting it.

The audio therefore follows at ~10 updates a second while dragging, which the
gain ramp in step 4 smooths into a continuous move.

(`primitives/editable-field` is the same shape for text — debounced autosave
plus echo reconciliation — but it is `T extends string` and carries caret
mapping, so it does not fit a numeric fader. Worth generalizing later; not part
of this change.)

**Files:** `plugins/apps/plugins/sonata/plugins/track-mixer/web/components/track-mixer-panel.tsx` ·
`plugins/apps/plugins/sonata/plugins/track-mixer/web/use-track-fader.ts` (new)

## 4. Channel strips — `audio/plugins/engine`

`audio-engine.tsx` replaces `managersRef: Map<instrumentId, InstrumentVoices>`
with:

```ts
interface TrackChannel {
  gain: GainNode;              // the fader: connected to master
  voices: InstrumentVoices;    // created with createVoices(ctx, gain)
  instrumentId: string;        // what `voices` was built against
}
const channelsRef = useRef<Map<string, TrackChannel>>(new Map());
```

- **Reconcile effect.** Its stable fingerprint becomes the sorted, joined set of
  `(trackId → instrumentId)` pairs for tracks with audible notes, replacing
  today's set of distinct instrument ids. It creates a channel for a
  newly-audible track, and when an existing track's instrument changes it
  disposes the old voices and creates the new ones **into the same `GainNode`** —
  so the fader position and any in-flight ramp survive an instrument change.
  Tracks that drop out get `voices.dispose()` + `gain.disconnect()`.
- **Initial gain** is written directly (`gain.gain.value = …`) at creation, read
  through a latest-ref: nothing has played through the node yet, so there is
  nothing to click.
- **A separate volume effect** applies changes to live channels with
  `gain.setTargetAtTime(target, ctx.currentTime, 0.03)`. It is keyed on a stable
  fingerprint of the volume map *and* on the reconcile fingerprint, so a channel
  created mid-session immediately picks up the current position.
- **The volume map must never be a dependency of the scheduling rebuild effect.**
  That effect cancels and re-attacks every ringing note when it runs — it is the
  same hazard the tempo jog-wheel was fixed for. Dragging one track's fader must
  not cut every other track's sound, so volume is read through a ref everywhere
  outside its own effect.
- `resolveVoices(trackId)` simplifies to `channelsRef.current.get(trackId)?.voices`.
  `trackInstrumentMap` **stays** in the rebuild effect's deps, for a new reason:
  a rebuild is what awaits the new instrument's `loaded` promise and gives a
  clean `allOff` → dispose → create → re-attack cutover.
- Status / load-error effects iterate channels instead of managers; the mount
  effect's cleanup disposes voices *and* disconnects gains.

**Mute and volume 0 stay different mechanisms.** Mute removes a track's notes
upstream, so a muted track has no channel at all — no sample load, no scheduling
cost. Volume 0 is a fader position on a channel that keeps existing and keeps
being scheduled, so raising it again is instant, and folding it into the audible
set would make every fader-to-zero cut every other track's ringing notes.

**Files:** `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/components/audio-engine.tsx` ·
`plugins/apps/plugins/sonata/plugins/audio/plugins/engine/CLAUDE.md` (rewrite the
"Per-track instrument routing" section as "Per-track channel strips"). The
scheduler's `resolveVoices` contract is unchanged, so `scheduler.ts` is untouched.

## 5. Shared sample loader — `audio/plugins/sample-loader` (new leaf)

Per-track managers mean N instances of the same instrument. smplr accepts a
shared `loader` on every instrument factory (`loader` is in its
`SMPLR_OPTION_KEYS`, so both `SplendidGrandPiano` and `Soundfont` take it), and
`SampleLoaderImpl` caches decoded `AudioBuffer`s by resolved URL — so one loader
per `AudioContext` collapses N downloads and N decodes back to one.

New leaf under `audio/plugins/sample-loader/web`, exporting
`sharedSampleLoader(ctx: BaseAudioContext)` backed by a
`WeakMap<BaseAudioContext, SampleLoader>` (a WeakMap because the engine builds a
fresh context per mount, and StrictMode builds two). It owns the `smplr`
dependency for the loader import.

Both `audio/plugins/piano/web/voices.ts` and
`audio/plugins/soundfont/web/voices.ts` then pass `loader` alongside their
existing `destination` / `baseUrl` options. Nothing else changes in either
wrapper — they are already destination-agnostic, so routing them into a per-track
gain instead of master needs no edit. The live-play engine, which builds its own
voice manager for hand-played notes, gets the same dedup for free.

## Not affected

`scheduler.ts`, the metronome (own click voice, wired straight to
`ctx.destination`), `live-play` (own manager into `master`), `piano-keyboard`
(reads the track hooks for key lighting only), and the `audio-store` `AudioGraph`
(`master` is still the single master gain — the per-track gains sit in front of
it).

The per-song reset button already deletes the rows, so it resets levels for free.

## Verification

1. `./equin build` — run it in the background; it generates the migration
   for the new column, regenerates the plugin docs, and runs the checks.
   Confirm the deploy receipt at
   `~/.singularity/worktrees/<worktree>/build-status.json` reads `status: ok`.
2. `./equin check` — `migrations-in-sync`, `type-check`,
   `plugin-boundaries`, `plugins-doc-in-sync`, and the CSS / data-view lint
   rules all matter here (the new primitive, the new leaf plugin, the reworked
   row).
3. Screenshot the panel and the hover reveal:
   ```
   ./equin run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
     --path /sonata/song/<id> --out /tmp/mixer
   ```
4. New E2E script `plugins/apps/plugins/sonata/plugins/track-mixer/e2e/track-fader.ts`
   (manual, like every other `e2e/`): open a song, hover a track's speaker,
   assert the fader appears and the panel widens, drag it, assert the persisted
   row, then click the speaker and assert it mutes without the fader having
   swallowed the click.
5. `query_db` on `sonata_track_view` to confirm `volume` lands and that mute /
   color / instrument were not clobbered by the partial-patch upsert.
6. By ear, in the browser — the part no script can check: drag one track's fader
   mid-playback and confirm the other tracks' sounding notes are not cut, that
   the level moves smoothly rather than in audible steps, that boosting past
   100% is louder, and that an instrument change keeps the fader position.
