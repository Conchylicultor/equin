# Per-Hand Accompaniment Figurations for Sonata

## Context

Sonata turns authored chord symbols (Cmaj7, G7, …) into performed notes via a
**voicing** step. Today that step is weak in two ways:

1. **Few patterns.** Only three "strategies" exist (`block-full`, `block-triad`,
   `arpeggio-up`). The catalog of real piano accompaniment figures — Alberti
   bass, octave bass, root–fifth, stride, waltz, oom-pah, broken chords,
   1‑5‑8‑5, walking bass, boogie, harp roll — is entirely missing.
2. **Not per-hand.** The chosen strategy is a **single global config**
   (`voicingConfig.strategyId`) whose `voice()` emits **both** hands at once; the
   left hand (bass) always just gets a single low root. You cannot say
   "left hand = Alberti, right hand = block".

Meanwhile the *rhythm* axis is already the opposite: `RhythmHands = {bass,chord}`
is **per-song, per-hand**, persisted in `sonata_songs_ext_rhythm`, edited in the
rhythm/groove panel.

A researched pattern catalog (`scratchpad/accompaniment-patterns.md`, §5.3) gives
the key insight: **every accompaniment pattern = (tone-order) × (rhythm-grid),
two independent fields.** Sonata already owns the rhythm-grid per hand. The
missing half is the **tone-order**, i.e. *which* tone(s) to strike at each onset.
This plan introduces that half as a per-hand **figuration** so the bass and chord
tracks each pick their own pattern, and expands the pattern set to the catalog.

Outcome: pick a distinct left-hand and right-hand accompaniment pattern per song,
composed freely with each hand's existing rhythm necklace.

---

## The abstraction: `Figuration`

A figuration is the tone-order companion to the rhythm necklace: given a placed
chord and an onset's position, it returns the pitch(es) to strike **for one
hand**. It generalizes the existing `chordTonesAt(tones, onsetIndex)` plug-point
inside `voiceRhythm` and applies it to *both* hands.

New pure leaf file: `plugins/apps/plugins/sonata/plugins/voicing/core/figuration.ts`
(imports only `theory/core` for pitch math + `score/core` for `ChordData`;
re-exported from `voicing/core/index.ts`). **Co-located in `voicing`, not a new
sibling plugin** — figuration has exactly one consumer (voicing's emission
engine) and operates on `chordPitches` output that voicing already owns; a
separate leaf would add a cross-plugin edge for no boundary benefit. (Mirrors the
existing note on `voicing`: the registry can be promoted to a slot later without
changing the types.)

```ts
export type HandRole = "bass" | "chord" | "both";
export type Register = "bass" | "chord";

export interface StruckTone { pitch: number; k: number; } // k = within-onset id index

export interface FigurationContext {
  chord: ChordData;
  chordTones: readonly number[];       // placed chord-register tones (post voice-leading), ascending
  bassTones: readonly number[];        // placed bass-register tones (low octave, root position), ascending
  onsetIndex: number;                  // running index over the hand's necklace
  positionInChord: number;             // 0-based onset ordinal since this chord began
  nextChord: ChordData | null;         // walking-bass approach tone
  bassTonesOfNext: readonly number[];
  firstOnsetOfChord: boolean;
  lastOnsetBeforeChange: boolean;
}

export interface Figuration {
  id: string;
  label: string;
  role: HandRole;
  select: (ctx: FigurationContext) => StruckTone[]; // [] = a legitimate rest, not a failure
}
```

`select` returning `[]` is real data (silence, e.g. an off-beat-only pattern);
an unknown id throws in `findFiguration` (a bug, not an absorbable value).

### Declarative common case — degree-sequence

Most patterns are a **cyclic degree-sequence** walked against the necklace,
keyed on `positionInChord` so every chord restarts its figure on its own root
(catalog §1.3 — fixes today's `arpeggio-up`, which cycles the global index).

```ts
export type Degree =
  | { kind: "tone"; index: number; octave?: number }       // stacked-third index: 0=root,1=3rd,2=5th,3=7th
  | { kind: "color"; semitones: number; octave?: number }  // above placed root: 6=+9, b7=+10 (boogie)
  | { kind: "all"; from?: number; to?: number; reg?: Register }; // block / stab / roll span
```

Readable tokens: `D1,D3,D5,D7` (`tone` 0–3), `D8` (root+12), `D6/Db7` (color),
`ALL`, `TRIAD` (`{all,to:3}`). One resolver owns degree→pitch **and** the §5.4
fallback (a requested stacked-third the chord lacks — e.g. `7` on a triad —
substitutes the octave root). `cyclicFiguration(id,label,role,homeReg,degrees)`
builds these; the `all` token can reach the *other* register (`reg:"chord"`) so a
bass-hand figuration can play weak-beat chord stabs (stride/oom-pah/waltz).

### Generative escape hatch

Walking bass (root on beat 1, chromatic-below approach on the last onset before a
change, chord tones between), harp roll (all tones across two octaves at one
onset) supply `select` directly, reading `nextChord`/`bassTonesOfNext`/the
bar-position flags.

### Registry + generic API

`FIGURATIONS: Figuration[]`, `findFiguration(id)` (throws on unknown),
`figurationsForHand("bass"|"chord")` (role filter for the UI dropdown),
`DEFAULT_BASS_FIGURATION_ID = "root"`, `DEFAULT_CHORD_FIGURATION_ID = "block"`.
Consumers use **only** this generic collection API — never a named figuration
object (collection-boundary rule).

Planned entries: `block`, `block-triad`, `harp-roll` (chord); `arpeggio-up`,
`arpeggio-down`, `broken-updown`, `alberti` (both); `root`, `octave-bass`,
`root-fifth`, `pop-1585`, `boogie`, `stride`, `waltz`, `oom-pah`, `walking`
(bass).

---

## Engine refactor — `voicing.ts` + `revoice.ts`

**`voicing.ts`**: replace the `Voicing`/`VOICINGS`/`findVoicing` registry with a
single exported engine `voiceChords(events, opts): Note[]`. `VoicingOptions`
gains `figuration?: { bass: Figuration; chord: Figuration }` (present only with
`rhythm`).

- **No-groove path (`opts.rhythm` absent): unchanged, byte-for-byte** — one block
  note per placed tone per chord, bass root iff `voiceLead`. A figuration only
  bites when a necklace exists. Preserves the shell's documented "`null` ⇒ today's
  block-chord behaviour".
- **Groove path**: place **two** tone-sets per event — `chordTones` =
  `chordPitches(ev.data, octave)` then `nearestVoicing` when `realistic`
  (voice-leading stays an orthogonal modifier, chord hand only); `bassTones` =
  `chordPitches(ev.data, BASS_OCTAVE)` (root position, low). `voiceRhythm` then
  walks each hand's necklace calling that hand's `figuration.select(ctx)`.
  Default `{bass:"root", chord:"block"}` reproduces today's rhythm behavior.

`emitRhythmicHand` gains cheap `positionInChord` (reset when the event index
advances) and `lastOnsetBeforeChange` (peek the next onset) inside its existing
O(n+m) pointer merge. Bass note ids become `-b{onset}-{k}` (was `-b{onset}`)
since a bass figuration can strike a dyad — internal to voicing, opaque
downstream.

**`revoice.ts`**: `reVoiceChords(score, cfg, groove?)` where
`cfg = {realistic, octave}` (drop `strategyId`) and
`groove = { hands: RhythmHands; bassFigurationId: string; chordFigurationId: string } | null`.
When `groove` present, resolve the necklaces (unchanged `resolvePattern`) into
`opts.rhythm` and the ids into `opts.figuration`. Track plumbing
(`CHORD_TRACK`/`CHORD_BASS_TRACK`) untouched.

---

## Placement — per-song, bundled with the groove (recommended)

The tone-order and rhythm-grid are the two halves of one pattern (§5.3); the
rhythm-grid is already per-song per-hand, so the tone-order lives in the **same
row**. This keeps one concept in one persistence home, makes the no-groove path
fall out for free (no "figuration set but no rhythm to apply it to" limbo), and
cleanly splits the two panels:

- **`voicing-controls` (global)** keeps only genuine global placement knobs:
  `realistic` voice-leading + `octave`. The strategy `SegmentedControl` is
  removed.
- **`rhythm-controls` (per-song)** becomes the single groove surface: per hand, a
  **Pattern** picker (tone-order / *what*) above the existing rhythm **Preset** /
  rotation / subdivision controls (rhythm-grid / *when*) — the two orthogonal
  axes shown adjacently.

(Rejected: a global `bassPatternId`/`chordPatternId` on `voicingConfig` — it
can't vary per song and strands the tone-order away from the rhythm-grid it must
combine with.)

### Persistence & wiring changes
- **DB** `rhythm-controls/server/internal/tables.ts`: add
  `bassPatternId text NOT NULL default "root"`, `chordPatternId text NOT NULL
  default "block"` (import the default-id constants from `voicing/core`).
  Migration generated by `./equin build` — **never hand-written**. Existing
  rows backfill to today's sound.
- **Wire/endpoint** `shared/resources.ts` + `shared/endpoints.ts`: `RhythmRow` +
  `setRhythmEndpoint` body gain `bassPatternId`/`chordPatternId` (`z.string()`;
  unknown ids throw loudly downstream).
- **Server** `routes.ts` upsert + `resource.ts` loader carry the two ids.
- **Shell store** `shell/web/rhythm-store.ts`: widen payload from
  `RhythmHands | null` to `RhythmGroove | null` where
  `RhythmGroove = { hands: RhythmHands; bassFigurationId: string; chordFigurationId: string }`;
  rename hooks `useRhythmGroove`/`useSetRhythmGroove`; update `shell/web/index.ts`.
- **Shell context** `shell/web/context.tsx`: read `useRhythmGroove()`, pass it as
  the 3rd arg to `reVoiceChords` (update `baseScore` deps); `voicing` no longer
  carries `strategyId`.
- **rhythm-controls web** `use-groove.ts` / `actions.ts` / `rhythm-observer.tsx`:
  thread the two ids through the `Groove`/`RhythmGroove` type, the store writer,
  and the observer's collapse (same sole-owner logic).

### UI
- **`rhythm-controls/web/components/track-config.tsx`**: extend props with
  `hand: "bass"|"chord"`, `figurationId`, `onFigurationChange`; add a "Pattern"
  `Select` populated by `figurationsForHand(hand)` at the top of each block
  (same `Select` idiom as the existing preset dropdown).
- **`rhythm-controls.tsx`**: pass `hand`/`figurationId`/`onFigurationChange`,
  commit via `useGroove().commit`.
- **`voicing-controls.tsx`**: remove the strategy control + `VOICINGS` import;
  keep realistic + octave.

No new slots; no shell import of a feature plugin; the dropdown reads the pure
`voicing/core` collection API directly.

---

## Delivery phases (all designed now; each independently shippable — the registry is additive)

1. **Phase 1 — core.** Figuration abstraction + engine/config/persistence/UI
   refactor + the single-register declarative set: `block`, `block-triad`,
   `arpeggio-up/down`, `broken-updown`, `alberti`, `root`, `octave-bass`,
   `root-fifth`, `pop-1585`, `boogie` (declarative color tones). Full per-hand
   selection working end-to-end. This is the bulk of the value.
2. **Phase 2 — two-register.** `stride`, `oom-pah`, `waltz` (bass-hand figures
   that strike chord-register stabs on weak beats) once the two-register ctx is
   proven.
3. **Phase 3 — generative.** `walking` (next-chord approach tones) and
   `harp-roll` (intra-onset spread).

---

## Verification

- **New `voicing/core/figuration.test.ts`** (bun:test, co-located). Fixed ctx
  (C-maj triad `bassTones=[36,40,43]`, `chordTones=[60,64,67]`), assert struck
  pitches by `positionInChord`: alberti → `36,43,40,43`; octave-bass → `36,48`;
  §5.4 fallback: `arpeggio-up` `D7` on a triad → `48`; boogie `D6`→`45`,
  `Db7`→`46`; block → whole set. Later phases add stride (position 1 →
  `[60,64,67]`), walking (approach → `42`), harp-roll (6 tones, sorted).
- **Update `voicing/core/voicing.test.ts`**: no-rhythm block tests unchanged;
  rhythm-path bass ids gain `-{k}`; add a test passing explicit per-hand
  `opts.figuration` and asserting the two hands differ.
  Run: `bun test plugins/apps/plugins/sonata/plugins/voicing`.
- **End-to-end** (`run`/`verify` skills): `./equin build` (generates the
  migration + typechecks the DAG), open a chord song, enable the groove, set
  LH = Alberti / RH = block, confirm the `chords` / `chords-bass` tracks + audio
  reflect the per-hand figures on the piano roll; reload → persists; open a
  different chord song → its own defaults (no leakage).

---

## Risks & coupling

- **config_v2 `strategyId` removal** — confirm config_v2 tolerates a dropped
  field (missing keys → defaults; orphan stored values ignored); if a version
  bump is needed, leave it a deprecated no-op instead. Blast radius: only
  `config.ts`, `revoice.ts`, `voicing-controls.tsx`.
- **Bass note-id `-b{i}` → `-b{i}-{k}`** — internal to voicing, opaque
  downstream; only `voicing.test.ts` expectations move.
- **Boundary rules honored** — shell imports only `voicing/core` (pure leaf),
  never a feature plugin; `rhythm-controls` (feature) writes the shell store, not
  the reverse; new edge `rhythm-controls/server → voicing/core` is feature→leaf
  (allowed); consumers touch only `FIGURATIONS`/`findFiguration`/
  `figurationsForHand`.
- **Walking-bass single-onset chord** — first==last onset; the approach branch
  wins only when `bassTonesOfNext` exists (documented on the figuration).

---

## Critical files

- `plugins/apps/plugins/sonata/plugins/voicing/core/figuration.ts` — **NEW**:
  types, degree resolver + §5.4 fallback, `cyclicFiguration`, generative
  figurations, registry, generic API.
- `plugins/apps/plugins/sonata/plugins/voicing/core/voicing.ts` — single
  `voiceChords` engine; per-hand figuration in `voiceRhythm`; remove `VOICINGS`.
- `plugins/apps/plugins/sonata/plugins/voicing/core/revoice.ts` — new
  `cfg`/`groove` signature; resolve figurations.
- `plugins/apps/plugins/sonata/plugins/voicing/core/config.ts` &
  `.../core/index.ts` — drop `strategyId`; export the figuration API.
- `plugins/apps/plugins/sonata/plugins/rich/plugins/rhythm-controls/server/internal/tables.ts`
  — two new columns (migration via `./equin build`).
- `.../rhythm-controls/shared/{endpoints,resources}.ts`,
  `.../server/internal/{routes,resource}.ts` — carry the two ids.
- `.../rhythm-controls/web/{use-groove,actions}.ts`,
  `.../web/components/{rhythm-observer,rhythm-controls,track-config}.tsx` — groove
  type + per-hand Pattern picker.
- `plugins/apps/plugins/sonata/plugins/shell/web/{rhythm-store,index,context}.tsx`
  — widen store to `RhythmGroove`.
- `plugins/apps/plugins/sonata/plugins/rich/plugins/voicing-controls/web/components/voicing-controls.tsx`
  — remove the strategy control.
- `plugins/apps/plugins/sonata/plugins/voicing/core/{figuration,voicing}.test.ts`
  — pure unit tests.
</content>
</invoke>
