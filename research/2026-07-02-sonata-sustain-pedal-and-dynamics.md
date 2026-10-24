# Sonata: realistic sustain pedal & dynamics — investigation + plan

## Context

Sonata's playback sounds mechanical. This investigation establishes **why**, verified
against the actual audio engine and the `smplr@0.26.0` source, and proposes a concrete,
low-risk plan for a realistic **sustain pedal**, plus a documented (not-yet-scoped) menu
of **dynamics** options with tradeoffs.

The deliverable of *this* task is the plan below — no implementation yet.

---

## How playback works today (source-verified)

- **Engine:** Sonata wraps **smplr** (`^0.26.0`) — a raw-Web-Audio sampler, not Tone.js.
  - Piano = `SplendidGrandPiano` (real Steinway samples, **5 genuine velocity layers**: ppp/pp/mp/mf/ff) — `plugins/apps/plugins/sonata/plugins/audio/plugins/piano/web/voices.ts`.
  - GM instruments 1–127 = `Soundfont` (MIDI.js `MusyngKite`), **1 sample per pitch, velocity only scales gain** — `.../audio/plugins/soundfont/web/voices.ts`.
  - One shared `AudioContext` + a single **master** `GainNode`; **no per-track gain, no reverb/effects** — `.../audio/plugins/engine/web/components/audio-engine.tsx`.
- **Scheduling:** a bounded, timer-free look-ahead loop (`.../engine/web/scheduler.ts`) hands each `Note` to `voices.schedule({pitch, velocity, when, duration})`.
- **Note trigger:** `schedule()` calls smplr's `piano.start({ note, velocity, time, duration })` — a **combined note-on + auto note-off**: smplr stops the voice at `startT + duration` (line 1173–1176 of the cached `smplr/dist/index.mjs`) with a linear release ramp (`decayTime` default **0.5 s**).
- **Velocity:** already wired end-to-end — `Note.velocity` (`score/core/types.ts`) → scheduler → `ScheduledNote` → smplr. Nothing to plumb.
- **Data model** (`score/core/types.ts`): `Score { notes: Note[], tracks, tempoMap, timeSigMap, annotations, meta }`; `Note { pitch, start, duration, velocity, track, voice? }`. **No pedal, articulation, or CC field anywhere.**

### The decisive smplr finding — CC64 is *not* a damper pedal in 0.26.0

The web docs claim "call `piano.setCC(64, 127)` to sustain." **That is false for the pinned version.** In `smplr@0.26.0`:

- `setCC(cc, value)` only stores CC state, consumed by `RegionMatcher.match()` to pick a **sample region** whose `ccRange` matches (index.mjs:990 comment; :1137 usage).
- A scheduled note with a `duration` is stopped **unconditionally** at `startT + duration` — the stop path **never consults CC state** (index.mjs:1173–1176).
- `SplendidGrandPiano`'s descriptor defines **no `ccRange` regions at all**, so `setCC(64,…)` on the piano is a complete no-op (no hold, no resonance).

⇒ Relying on smplr's native CC64 to hold notes **cannot work** without forking/upgrading smplr. This is the crux that rules out the "just call setCC" approach and validates resolving pedal ourselves.

---

## Why it sounds mechanical — three independent root causes

1. **No sustain pedal.** Bach's Prelude and Für Elise are *pedal* pieces; their broken-chord figuration is meant to ring together. Notes are even gated to `duration × 0.98` (detached), so arpeggios sound dry and disconnected.
2. **Flat velocity.** The built-in demos use **exactly one constant velocity per hand** — Bach LH 60 / RH 72, Für Elise LH 60 / RH 76 (`.../sources/plugins/midi/server/internal/{bach-prelude,fur-elise}.ts`). Every note in a hand is identical: no accents, no phrase shape, no crescendo.
3. **Bone-dry output.** No reverb anywhere — a dry sampled signal reads as "sampled/mechanical."

Sustain-pedal work fixes (1). Dynamics work (documented below) fixes (2)+(3).

### Does sustain pedal appear anywhere in existing data? — No.

- **Built-in demos:** `seed.ts` builds each MIDI from note arrays only (`midi.addTrack()` + notes); it adds **zero** control-change events. None of the three starters carry pedal.
- **User imports:** `parse.ts` reads only `midi.header` + `track.notes`; it **never reads `track.controlChanges`**, so CC64 present in an imported file is silently dropped. `@tonejs/midi` already parses it into `track.controlChanges[64]` — the data is available, just discarded.

---

## Decisions taken (this task)

| Axis | Decision |
| --- | --- |
| Pedal approach | **Offline duration-extension** (resolve pedal → longer *audio* durations at schedule time). |
| Pedal source | **Faithful MIDI CC64 import** only (no heuristic auto-pedaling). |
| Pedal UI | **Piano-roll pedal lane + always-visible toolbar indicator.** |
| Dynamics (velocity humanization / reverb / dynamics marks / per-track gain) | **Not yet scoped** — documented as an options menu, decided later. |

---

## Recommended plan — sustain pedal (offline duration-extension)

**Principle:** pedal events are **first-class `Score` data** (a pedal lane), *not* baked
into note durations and discarded. The audio path reads the lane to extend *sounding*
durations; the UI reads the *same* lane to draw pedal state. `Note.duration` (the
**notated** length) is never mutated — pedal extension is an **audio-only** concern.

### 1. Score IR — add a pedal lane
`plugins/apps/plugins/sonata/plugins/score/core/types.ts`
```ts
export interface PedalEvent {
  track: string;   // -> TrackMeta.id (CC64 is per-track/channel in MIDI)
  beat: number;    // quarter-note beats, like Note.start
  down: boolean;   // true = pedal pressed, false = released
}
export interface Score { /* …existing… */ pedalEvents: PedalEvent[]; }
```
- Update every `Score` constructor to default `pedalEvents: []` (chord-grid, ultimate-guitar, etc. simply produce none).
- Extend `mergeScores` to concat pedal events. Export `PedalEvent` from `score/core/index.ts`.

### 2. Pure resolver + audio injection (the whole audio behaviour)
Add a pure, unit-tested helper in `score/core` (co-located `*.test.ts`, `bun:test`):
```ts
// resolvePedalSustain(notes, pedalEvents) -> Map<Note, number>  // extended OFF-beat
```
Semantics (full-pedal model — "pretty" without half-pedal):
- A note's natural off = `n.start + n.duration`. If the pedal for `n.track` is **down** at that beat, extend its off to the **next pedal-up beat** on that track.
- **Re-strike cap:** clamp the extended off to the next onset of the **same pitch/track**, so re-hitting a key while pedal-down doesn't stack two ringing voices (matches a real string being re-struck).
- Notes not under pedal are unchanged.

Inject in `.../engine/web/scheduler.ts` — pedal spans are in **beats**, hence
tempo-invariant, so this survives `retime` for free:
```ts
const sustainOff = resolvePedalSustain(score.notes, score.pedalEvents);   // once
const durationSec = (n: Note): number =>
  tempo.beatToSeconds(sustainOff.get(n) ?? n.start + n.duration)
  - tempo.beatToSeconds(n.start);                                          // was n.start + n.duration
```
No change to `InstrumentVoices`, smplr, or the transport. This is the entire engine delta.

### 3. MIDI import — read CC64
`.../sources/plugins/midi/shared/parse.ts`: iterate `track.controlChanges[64]` and emit
`PedalEvent`s (`down = value >= 64`, the MIDI convention), keyed to the same track id the
notes use. Collapse consecutive same-state events. Everything downstream is automatic.

### 4. UI — piano-roll pedal lane + toolbar indicator
- **Pedal lane:** a new sub-plugin under the `piano-roll/` umbrella (mirrors the existing `fx-*` sub-plugin pattern) that reads `score.pedalEvents` and the roll's published time-axis **Projection**, drawing pedal-down spans as a thin scrolling strip along the keyboard line. Merge across tracks for the strip (a single visible pedal).
- **Indicator:** a small `Ped.` glyph (its own tiny plugin, contributed to a Sonata toolbar/transport slot) that reads the live cursor beat + `pedalEvents` and **glows while a span is active** — visible in *every* lens, not just the roll.

### Tradeoffs & the rejected alternative
- **Chosen (offline extension):** no engine/contract/smplr changes; deterministic; tempo-safe; unit-testable as a pure function. **Limits:** no half-pedal, no sympathetic string resonance, and long pedal spans raise simultaneous voice count (mitigated by the same-pitch re-strike cap + the 0.5 s release ramp).
- **Rejected (real-time pedal voice manager):** start notes *without* duration and have the engine defer each note-off until pedal-up. More faithful (models re-pedal/catch), but needs a new `sustain(on)` method on `InstrumentVoices`, a deferred-release map in the scheduler, and per-instrument cooperation — materially more invasive for a marginal audible gain over full-pedal. Keep as a future upgrade path only if half-pedal/live-pedal authoring is ever wanted.

### Known caveat — the built-in demos still won't pedal
Import-only means the three flagship starters (which contain **no** CC64) gain nothing, so
the feature ships invisible on default content. **Optional, low-effort follow-up** (not a
heuristic — just hand-authored demo data): add an optional pedal-span list to
`StarterTrack` and give Bach/Für Elise musically-correct pedaling in
`bach-prelude.ts` / `fur-elise.ts` + `seed.ts`, so the showcase pieces actually
demonstrate the feature. Flagging for a decision; not in the committed scope.

---

## Dynamics — options menu (documented, NOT yet scoped)

Velocity is already fully wired, so this is about *authoring/shaping fidelity* and *prettiness*, ranked by perceptual ROI vs effort:

| Option | What | Effort | Tradeoff |
| --- | --- | --- | --- |
| **Master reverb** | One shared convolver (IR) or smplr's bundled (unused) `DattorroReverb` worklet on the master bus. | Low | Biggest single "pretty" win; dry→spacious. Pick a tasteful small-hall IR; adds a little CPU. |
| **Velocity humanization** | Pure IR transform: metric accents (downbeats louder) + subtle ±jitter, so flat-velocity scores stop sounding robotic. | Low | Directly fixes the demos. Purely audio unless you also want it visible. |
| **Per-track gain / CC7·CC11** | Add a per-track `GainNode` between voices and master (engine has only master gain today); enables mix balance **and** importing expression curves. | Med | Clean, reusable (track-mixer currently lacks volume); continuous automation needs a small ramp scheduler. |
| **Dynamics annotations** | A `dynamics` annotation type (pp/mf/hairpins) scaling velocity over ranges — the "musical" authoring path; renders in notation. | Med–High | Most expressive/authentic; largest UI surface. The annotations layer already supports typed time-ranges. |
| **GM single-layer limit** | GM soundfont patches have one sample + gain (no timbre change with velocity), unlike the 5-layer piano. | — | Inherent to MusyngKite; only a different sample set fixes it. Note, don't fix. |

**Suggested first slice when dynamics is scoped:** *Master reverb + velocity humanization* — both low-effort, both fix the demos, neither touches the data model.

---

## Files to modify / reuse (pedal scope)

- `plugins/apps/plugins/sonata/plugins/score/core/types.ts` — `PedalEvent` + `Score.pedalEvents`.
- `plugins/apps/plugins/sonata/plugins/score/core/index.ts` — export `PedalEvent`, add + export `resolvePedalSustain` (+ co-located `bun:test`); update `mergeScores`.
- `plugins/apps/plugins/sonata/plugins/audio/plugins/engine/web/scheduler.ts` — call `resolvePedalSustain`, use it in `durationSec`.
- `plugins/apps/plugins/sonata/plugins/sources/plugins/midi/shared/parse.ts` — read `track.controlChanges[64]` → `PedalEvent[]`.
- `plugins/apps/plugins/sonata/plugins/piano-roll/plugins/<pedal-lane>/` — new sub-plugin (mirror `fx-core`), reads `pedalEvents` + Projection.
- New tiny plugin for the toolbar `Ped.` indicator (contributes to a Sonata toolbar/transport slot; reads cursor beat + `pedalEvents`).
- *(optional)* `.../sources/plugins/midi/server/internal/{starters,seed,bach-prelude,fur-elise}.ts` — author demo pedaling.

## Verification

1. `./equin build`, open `http://<worktree>.localhost:9000` → Sonata.
2. **Pure unit tests:** `bun test plugins/apps/plugins/sonata/plugins/score/core/` — cover `resolvePedalSustain`: extend-to-pedal-up, re-strike cap, no-pedal passthrough, un-pedaled tracks.
3. **Import fidelity:** import a real piano `.mid` known to contain CC64; confirm `pedalEvents` populate and pedalled passages ring vs. before.
4. **Audible A/B:** with pedal data present, held/arpeggiated passages sustain across the pedal span and release on pedal-up; unpedaled tracks unchanged.
5. **UI:** the piano-roll pedal lane shows down-spans scrolling under the notes; the toolbar `Ped.` indicator glows exactly during those spans, in every lens.
6. Scripted check via `e2e/screenshot.mjs` on `/sonata` with an imported pedalled song to capture the lane + indicator states.
