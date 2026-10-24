# Chord trainer: show the real chords

Track page: `block-49ba706c-affe-417b-a9a1-b6873e8c7ea8`. Track instructions:
`block-361815ed-5750-413a-b5ab-31c5dc855144`. Mockup: the prototype
`proto-1789461303-updb`, option `reveal: off | names | keyboard`.

## Context

The trainer plays loops, checks answers, tracks mastery and has a ladder. After
a round is checked, a box shows the chord as a Roman numeral and nothing else.
The learner is told they missed a `V7` but never what that chord actually was in
this song — its letter name, or which notes were sounding. For someone learning
to hear chords, the numeral alone is the abstraction without the sound behind
it.

The mockup answers this with one option in three values, and it is the track's
remaining `[later]` item. Today the app has none of it.

This plan also takes the two curriculum items the last session recorded in
`research/2026-09-19-apps-chord-trainer-curriculum.md`: the inversion run, and
the chords that cannot be answered from the keyboard.

**Exit criteria.** Setting *Reveal* to *Names* makes every chord on screen name
itself in the song's key; setting it to *Keyboard* adds a piano lighting exactly
the notes the app's own piano plays for that chord. The ladder no longer spends
ten consecutive levels on single inversions, and every unlocked chord can be
answered from the number keys.

---

# Part 1 — Reveal

## One axis, three values

`off` ⊂ `names` ⊂ `keyboard`: the keyboard value shows everything the names
value shows, plus the keyboard. That is one three-valued choice, not two
switches — the same reasoning that folded Sonata's look and key style into one
axis (`sonata/plugins/look/core/config.ts`). A pair of booleans would have an
unreachable combination (keyboard without names) and a rule to suppress it.

A `config_v2` enum config, so it persists and appears in Settings → Config. It
is read with plain `useConfig` (not `useConfigResult`): config is boot-hydrated
and resident, and reveal is a display preference like the look skin — it makes
no claim about the learner's data, so the documented `useConfig` case applies.

**The switch lives in the side panel**, as its own first row above *Today*: a
labelled `SegmentedControl` (`primitives/css/toggle-chip/web`), typed on the
`RevealMode` union. It reads as a learner setting, stays out of the main column,
and is visible whatever the round is doing.

## What each value shows

| | `off` | `names` | `keyboard` |
|---|---|---|---|
| Song card | — | a key tag: `G major` | same |
| Answer box | numeral | numeral + the chord's name under it | same |
| Chord button | "dominant" | the chord's name | same |
| Below the buttons | — | — | a card: the chord's name, its numeral, and a piano with its notes lit |

Before the check a filled box names **the answer the learner picked**, not the
real chord — the same rule the numeral already follows, so nothing leaks. After
the check it names the real one. The keyboard lights nothing until the round is
checked, for the same reason.

## Naming a chord in the song's key

### The key signature of a Hookpad key

A loop window carries `keyTonic` (a spelling, `"Bb"`) and `keyMode` (one of nine
Hookpad modes). Sonata's `KeySignature` is `{ tonic, mode: "major" | "minor" }`,
so a Dorian key cannot be spelled in it directly — but a modal key's *signature*
is its relative major's, which is all a speller reads.

New in `vocabulary/core/key.ts`:

```ts
export type SongKey = { tonic: string; mode: HookpadMode };

/** The key signature this song is written in, as the equivalent major key —
 *  what `makeKeySpeller` reads. D dorian ⇒ C major; E♭ mixolydian ⇒ A♭ major. */
export function songKeySignature(key: SongKey): KeySignature;

/** The key as the learner reads it: "G major", "E♭ mixolydian". */
export function songKeyLabel(key: SongKey): string;

/** Everything this song's key lets us say about a chord, built once per key. */
export function songVocabulary(key: SongKey): {
  nameChord(token: ChordToken): string;   // "D7", "D/F♯"
  noteName(pitch: number): string;        // "A♭", never "G♯" in E♭
};
```

`songVocabulary` builds one `KeySpeller` and closes over it, so a round's five
boxes and thirty lit keys share it and Sonata's `KeySpeller` type never reaches
the barrel.

`songKeySignature` is circle-of-fifths arithmetic:
`fifths = tonicFifths(tonic) + MODE_FIFTHS[mode]`, with `MODE_FIFTHS` = major 0,
lydian +1, mixolydian −1, dorian −2, minor / harmonicMinor −3, phrygian /
phrygianDominant −4, locrian −5.

The arithmetic itself is **not rewritten here**: `sonata/score/core/spelling.ts`
already does it privately in `keyFifths`, and a second copy in the chord app
could drift from the speller that reads it. That function splits into two
exports on `score/core` — `tonicFifths(tonic): number` and its inverse
`fifthsToTonic(fifths): string` — with `keyFifths` keeping its minor offset on
top. No behaviour change for its existing callers, and the inverse handles any
number of accidentals rather than a 15-entry table that runs out.

The raised degrees of the two altered modes (harmonic minor's 7th, phrygian
dominant's 3rd) are not in the signature; they fall to `makeKeySpeller`'s
non-diatonic default, which leans with the key — A harmonic minor's leading tone
comes out `G♯`, C harmonic minor's `B`. That is what a score would print.

### The name

`vocabulary/core/name.ts` holds what `songVocabulary` closes over — the chord's
absolute name in this song's key: `G`, `Em`, `D7`, `D/F♯`. It is reached only
through `songVocabulary`, so a caller cannot build a name against one key and a
note label against another.

The numeral and the letter name must never describe different chords, so both
read **one** reading of the stack. `label.ts`'s two private steps move down into
`vocabulary/core/stack.ts`, beside `chordStack` itself, and become exports:

```ts
/** The Sonata quality this stack is, or `undefined` when it is none of them. */
export function matchChordTemplate(stack: ChordStack): ChordTemplate | undefined;

/** A stack Sonata has no quality for, as chord members: "3,5,9". Never refused. */
export function spelledTones(stack: ChordStack): string;
```

`chordLabel` now calls them instead of its own copies — no behaviour change, and
no new file. `chordName` makes the *same* `matchChordTemplate` call, so the two
readings are the same chord by construction. A matched quality goes through
Sonata's own
`formatSpelledChordSymbol({ root, quality, bass }, speller)` (absolute pitch
classes = `hookpadTonicPc(key.tonic) + stack.root`, and the bass likewise), which
already appends the slash bass for an inversion and spells both through the
key's speller; an unmatched stack is the root's note name plus the same
parenthesised `spelledTones` the numeral wears, with `/<bass>` when inverted.

So `V⁶⁵` in G reads `D7/F♯` — the figure and the slash say the same thing two
ways, which is the point of showing both.

### Tests (pure, `bun:test` beside the source)

- `key.test.ts` — `songKeySignature`: C major → C; A minor → C; D dorian → C;
  E♭ mixolydian → A♭; F♯ dorian → E; F lydian → C; B locrian → C;
  A harmonicMinor → C; C phrygianDominant → A♭; C♯ major → C♯; G♭ lydian → D♭.
  `noteName`: in E♭, pc 8 is `A♭`; in E, pc 6 is `F♯`; A harmonic minor's pc 8
  is `G♯`.
- `name.test.ts` — in G: I `G`, IV `C`, V `D`, V7 `D7`, vi `Em`, vii° `F♯dim`,
  V⁶ `D/F♯`, I⁶₄ `G/D`; in E♭: IV `A♭`; in C minor: ♭VII `B♭`; an untemplated
  stack → `C(2,5)`; a lone root → `C(1)`; and one property test that the name
  carries a slash bass exactly when `chordLabel` reports an inversion.

## The keyboard

A new sub-plugin `plugins/apps/plugins/chord/plugins/reveal/`, sibling to
`vocabulary` / `curriculum` / `progress`, imported by `trainer` only — nothing
imports `trainer`, so there is no cycle. It owns the config, the switch and the
card; the pure naming stays in `vocabulary`, where the numeral already lives.

```
reveal/
  core/index.ts, core/mode.ts        REVEAL_MODES / RevealMode
  shared/config.ts                   revealConfig (enumField, default "off")
  server/index.ts                    ConfigV2.Register
  web/index.ts                       useReveal, RevealSwitch, RevealKeyboardCard
  web/components/reveal-switch.tsx
  web/components/reveal-keyboard.tsx
  web/internal/keyboard-window.ts    (+ .test.ts)
  web/reveal.css
```

It borrows Sonata's keyboard whole, the way the trainer already borrows Sonata's
piano:

- **The plane** — `pitchGeometry("piano", low, high)` from
  `sonata/pitch-layout/core`. The layout is passed explicitly rather than read
  through `usePitchGeometry()`: that hook reads Sonata's own piano/Jankó
  setting, and the Chord app is not Sonata.
- **The keys** — `<Keyboard plane lit renderKey style/>` from
  `sonata/primitives/keyboard/web`, exactly as
  `sonata/rich/chord-readout` uses it. Height is
  `pitchKeyboardHeight("piano", "chip")`.
- **The window** — `keyboard-window.ts`: C3–C6 (48–84) by default, widened
  outward by whole octaves only when a voicing falls outside, never shifted
  (`chordVoicing` already pins every chord's bass near middle C). Held constant
  across chords wherever it fits, so changing chord only re-lights keys instead
  of re-laying the keyboard out. Pure, with a unit test.
- **The lit notes are `chordVoicing(token, round.keyTonicPc)`** — the very call
  `usePiano` plays. The picture and the sound come from one expression, so they
  cannot disagree. (The mockup also draws a greyed root an octave below; we do
  not, because the app never plays that note.)
- **The colour** — the card's root is `.chord-tone` carrying
  `chordToneStyle(token)`, and the lit map is `pitch → "var(--fn-bg)"` with the
  labels in `var(--fn-ink)`. That is the same tile-and-ink pair a filled answer
  box wears, derived by the one `.chord-tone` rule, so a lit key reads as the
  same object as the box above it.
- **The labels** — `renderKey` prints `noteName(pitch)` on lit keys only. An
  unlit key says nothing.

The card's header line is the chord's name and its numeral side by side
(`D7 · V7`), so the three readings — letter name, numeral, notes — sit together.
With no chord shown it renders the same keyboard unlit with a muted line saying
what it is waiting for, rather than collapsing (the panel would otherwise jump
every time the playhead crosses a rest).

## How reveal reaches each surface

All of it threads through `trainer-screen.tsx`, which already owns the round and
the loop:

```ts
const reveal = useReveal();
const songKey = { tonic: loop.window.keyTonic, mode: loop.window.keyMode };
// One speller per loop, shared by every box, button and lit key.
const words = useMemo(() => songVocabulary(songKey), [songKey]);
const nameChord = reveal === "off" ? null : words.nameChord;
```

- `SongCard` gains `keyName: string | null` — the trainer passes
  `reveal === "off" ? null : songKeyLabel(songKey)`. It stays presentational.
- `AnswerStrip` / `AnswerBox` gain `nameChord: ((t) => string) | null`. A box
  with a chord shown adds the name under the numeral (the `Center` becomes a
  centred `Stack`) and into its `aria-label`.
- `ChordButtons` / `ChordPad` gain the same prop: the sub-line shows the name
  instead of the function word.
- `ProgressPanel` renders `<RevealSwitch/>` as its first row; the switch reads
  and writes the config itself, so the panel takes no new props.

### The chord on the keyboard

One value, `shownChord`, defined once in `Trainer` and used by the keyboard
card, the card's header and the lit chord button, so the three always agree:

```ts
// the playhead wins while the checked loop plays; otherwise the last chord
// the learner asked to hear
const shownChord = checked ? (soundingToken ?? pianoChord) : null;
```

`pianoChord` is set wherever the learner asks for a chord — a chord button after
the check, the "you: IV" tag, and a box replay (the box is replaying that
chord's stretch of the song). It lives as a field on `RoundSession`, which is
already minted fresh per loop and keyed on it, so moving to the next song clears
it with everything else and there is no reset to remember.

It is `null` before the check by construction, not by a guard: that is what
stops the keyboard giving the answer away. `litToken` is folded into it —
today it is only the sounding box.

---

# Part 2 — Two curriculum fixes

## The inversion run: one chord's inversions are one step

`ladder-preview` shows levels 11–20 as ten single inversions (V⁶, I⁶, i⁶₄, IV⁶₄,
♭VII⁶ …). Each is a level, and the level after it teaches the same idea again.
The curriculum's own rule is *one notion at a time*, and the notion here is not
"V⁶" — it is "V, with another note in the bass".

So a stage gets to say what one notion is. In `curriculum/core/stages.ts`:

```ts
type Stage = {
  …
  /** The NOTION a chord belongs to. Candidates sharing a notion are unlocked
   *  by ONE step, because they are one idea. */
  notion(parts: ChordTokenParts): string;
};
```

Required, not optional — a stage with nothing to group returns the exported
`ownNotion` (the chord itself), so "no bundling" is a stated answer rather than
a missing method, the way `decor()` returns `NO_DECOR`. `inversions.notion` is
the root-position twin's token.

In `ladder.ts`, `bestChordPerStage` becomes `bestNotionPerStage`: candidates are
grouped by `(stage, notion)`, a group is ranked by its **best** member, and the
step it produces carries every member, ordered by windows then token. Ranking
and the stage-hold rule are untouched. `NextStep.tokens` is already a list (the
minor-keys seed unlocks three at once), so nothing about the schema, the stored
rows or `curriculumFromSteps` changes.

The reported `windows` is the best member's, and the step opens at least that
many. Counting the set exactly would be one extra `countLoopsInSet` query per
notion on every `next` read; the ranking does not need it, because the biggest
member is what decides whether the family is worth a level.

The trainer's "a new chord is asked alone until it has ten answers" rule already
handles a step that unlocks several chords — it is what minor keys does — so the
bundle's members take turns as the target until each has settled.

Tests in `ladder.test.ts`: two inversions of one twin come back as one step
with both tokens in order; inversions of different twins stay separate steps; a
bundle's `windows` is its best member's; a non-bundling stage is unchanged.

## Answering from the keyboard: the second stroke, and more than seven

Two problems, one in `trainer/web/internal/use-chord-keys.ts`:

1. **A real bug.** The second stroke is registered only for digits that
   themselves hold a chord, because the shortcuts are built by mapping over the
   key plan. With chords on 1, 4 and 5, pressing `5` then `3` does nothing —
   the third chord on the 5 is unreachable from the keyboard today, long before
   the seven the comment promises.
2. **The cap.** Past seven chords on one digit there are no numbers left, and
   the overflow becomes click-only. Inversions and sevenths make that reachable:
   V, V⁶, V⁶₄, V7, V⁶₅, V⁴₃, V⁴₂ is already seven.

The fix keeps the grammar (digit, then number) and removes the cap:

- While a digit is armed it owns **all seven** number keys — the plan's own
  digit shortcuts stand down, so nothing else on the page hears the stroke
  (today's rule, now actually implemented).
- A digit with seven chords or fewer works exactly as now: keys 1…n pick.
- A digit with more uses keys 1–6 to pick and **key 7 to reach the rest**,
  wrapping. So no chord is ever unreachable, and the promise is kept by
  construction rather than by the curriculum staying small.
- On screen: at rest a pad on a ≤7 digit keeps its `5 2` badge. While its digit
  is armed, the pads on the page show their number; the pads of the same digit
  that are not, show `5 7` dimmed — labelled with the key that brings them into
  reach.

The paging arithmetic is pure and goes beside `chordKeyPlan` in
`vocabulary/core/keys.ts`:

```ts
/** Which chords the second stroke reaches right now, and the key for the rest. */
export function pickPage(
  tokens: readonly ChordToken[],
  page: number,
): { numbers: ReadonlyMap<ChordToken, ChordDigit>; pager: ChordDigit | null };
```

with unit tests at n = 1, 2, 7, 8, 13, 15 and across the wrap. `useChordKeys`
holds only `{ digit, page }` and renders it.

---

## Files

**New**

- `plugins/apps/plugins/chord/plugins/reveal/**` — as laid out above, plus
  `CLAUDE.md` and `package.json`.
- `plugins/apps/plugins/chord/plugins/vocabulary/core/{key,name}.ts` and
  `{key,name}.test.ts`.

**Changed**

- `vocabulary/core/{stack.ts,label.ts,keys.ts,index.ts}` — `stack.ts` gains the
  two factored exports and `label.ts` calls them; `keys.ts` gains `pickPage`;
  the barrel gains the new exports.
- `sonata/score/core/spelling.ts` + its barrel — `keyFifths` splits into the
  exported `tonicFifths` / `fifthsToTonic`, so the chord app reuses the circle
  arithmetic the speller itself reads. No behaviour change.
- `trainer/web/components/{trainer-screen,song-card,answer-strip,chord-buttons,progress-panel}.tsx`,
  `trainer/web/internal/use-chord-keys.ts`, `trainer/web/components/trainer.css`.
- `curriculum/core/{stages.ts,ladder.ts}` and `ladder.test.ts`.
- `CLAUDE.md` for `chord`, `vocabulary`, `trainer`, `curriculum`.

## Verification

1. `./equin test plugins/apps/plugins/chord` — the pure tests above.
2. `./equin build` (background): migrations, boundaries, type-check, the
   plugin docs.
3. `./equin run …/curriculum/e2e/ladder-preview.ts` — the first ~20 levels
   against this worktree's index, to see by eye that the inversion levels are
   now per chord and how far down the ladder reaches.
4. `…/trainer/e2e/trainer-verify.ts`, extended: with reveal set to `keyboard`,
   a checked round's boxes carry their chord's name in the `aria-label`, and
   clicking a chord button lights the keyboard's keys — read off the
   `data-pitch` attributes and checked against `chordVoicing` computed in the
   script, which is the end-to-end proof that the picture matches the sound.
5. Screenshots of `/chord` at each of the three reveal values
   (`screenshot.ts --path /chord`), compared against the mockup rendered at the
   same option (`/api/prototypes/proto-1789461303-updb/index.html?reveal=…`).
6. By hand: the two-stroke key on a digit with two chords, and the pager once a
   digit holds eight (reachable by unlocking inversions with *Add anyway*).
7. Track page: an update card and the progress list; then the follow-up task
   carrying the page id and `block-361815ed-5750-413a-b5ab-31c5dc855144`.

## Left open

- **The keyboard's skin follows Sonata's look.** `Keyboard` reads
  `sonataLookConfig` for its flat / realistic / drawn skin, so a learner who set
  Sonata to *Sketch* gets hand-drawn paper keys inside the onyx Chord app. The
  default is *Flat*, which is what the mockup draws, so this ships as is. If the
  screenshot review shows it jarring, the fix is an optional `skin` prop on
  `KeyboardProps` defaulting to the look — about ten lines, threading one value
  the chromes already receive.
- **Naming is per key, not per chord's own spelling.** A borrowed chord is named
  through the song's signature (♭VI in C reads `A♭`, not `G♯`), which is right
  for a diatonic reading and will occasionally disagree with how a lead sheet
  spells a secondary dominant. Worth revisiting if it reads wrong once secondary
  dominants are on the ladder.
- **Reveal is machine-global**, like every other `config_v2` value. Per-app
  scoping exists but buys nothing here — there is one learner.
