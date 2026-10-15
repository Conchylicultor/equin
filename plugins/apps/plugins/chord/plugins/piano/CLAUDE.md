# piano

The Chord app's piano: the notes it plays for a chord, the keyboard that draws
and plays them, and the sound mix — the song and the piano as two channels,
each on or off at its own level.
Design: `research/2026-09-20-apps-chord-trainer-reveal.md` (Part 1, whose
three-valued reveal setting this replaced); the look is the prototype
`proto-1789461303-updb`.

This plugin owns **both the sound and its picture**, and that is the whole
point of it being one plugin. A keyboard that lit keys the app did not play, or
a piano that played notes the keyboard did not draw, would be a lie the learner
has no way to catch — they are learning what a chord SOUNDS like from what they
SEE. One folder, one expression (`chordSound`), so there is no second place a
disagreement could live.

## Always on

There used to be a three-valued `reveal` setting — off / names / names and
keyboard — so the keyboard was one of three things the trainer might show. It is
gone: the keyboard is always there, and a chord is always named.

The setting was answering a question nobody asked. Nothing is shown until the
round is CHECKED, so the keyboard never gave an answer away; turning it off
bought no difficulty, it only took away the part of the screen that teaches.
Removing it also removes every `reveal === "off"` branch downstream — the song
card's key tag and the box and button names stopped being nullable, which is
three `| null` props and four ternaries that no longer exist.

## What the app plays

`chordSound(token, tonicPc)` (in `vocabulary`) is the one answer, and it has
three parts:

| | what it is |
|---|---|
| `voicing` | the close voicing, its inversion's tone lowest — what the chord IS |
| `bass` | that lowest note doubled an octave below — what holds it up |
| `pitches` | the two together, ascending: what is played, and what is lit |

The doubled bass is new, and it is played as well as drawn. The mockup draws a
greyed root below the chord and the first version of this card deliberately did
not, on the grounds that the app never played that note. The answer was to play
it: a chord with a bass under it reads as a record's chord rather than as three
notes in the middle of the keyboard, and the octave is where the bass of an
inversion becomes audible AS the bass. It is drawn in `--fn-bass` — the chord's
own colour pulled most of the way to grey — so it reads as support rather than
as a fourth chord tone.

**Yes, the data has the inversions.** Hookpad records one per chord, Sheet
Sage's reading passes it through (`HookpadChordSound.inversion`), and the token
spells it (`7:4-3-3/1` is a V7 with its 3rd in the bass). `chordStack` counts
the stack's tones from the bottom to find it and `chordVoicing` puts that tone
lowest, so the app has reflected the inversion since the voicing existed. What
the data does NOT have is a voicing: Hookpad is a lead sheet, so there is no
register, no spacing and no doubling in it. Those are this plugin's choice, and
the choice is stated in one place — close position, bass pinned near middle C,
one octave doubling — rather than guessed per surface.

## The keyboard

`<PianoCard token songKey tonicPc play/>` borrows Sonata's keyboard whole:

- **The plane** — `pitchGeometry("piano", low, high)`. The layout is passed
  explicitly rather than read through `usePitchGeometry()`: that hook reads
  Sonata's own piano/Jankó setting, and the Chord app is not Sonata.
- **The window** (`web/internal/keyboard-window.ts`) — C2–C6, four octaves,
  widened OUTWARD by whole octaves while a note falls outside, never shifted.
  Four rather than the three it started at: these keys are what the learner
  reads the chord off, so the keyboard is the size of an instrument, and a bass
  two octaves under the melody has somewhere to be drawn. `chordVoicing` pins
  every chord's own bass to F♯3–F4, so the doubled bass never falls below F♯2
  and the window stays put — changing chord re-lights keys instead of re-laying
  the keyboard out.
- **The height** — `pitchKeyboardHeight("piano", "keybed")`, the full keybed
  rather than a readout chip's.
- **The colour** — the card's body is `.chord-tone` carrying
  `chordToneStyle(token)`; the lit map is `pitch → var(--fn-bg)`, the bass
  `var(--fn-bass)`, and the labels `var(--fn-ink)` / `var(--fn-bass-ink)`. The
  first pair is what a filled answer box already wears, so a lit key reads as
  the same object as the box above it.
- **The labels** — `noteName(pitch)` on lit keys only, spelled by the song's key
  (`A♭` in E♭, never `G♯`). An unlit key says nothing.

**The keys are played.** `interaction` makes the keyboard a live instrument:
clicking, tapping or sliding across it strikes that note on the same piano, and
the key lights while it is held. The keyboard primitive already owned the
pointer tracking (multi-touch and glissando come free from `data-pitch`), so
this is one `onPress` / `onRelease` pair, not a gesture layer.

**Nothing is lit before the check**, by construction: the trainer's shown chord
is `null` until the round is checked, so there is no guard here that could be
forgotten. With `null` the card draws the SAME keyboard, unlit and still
playable, with a line saying so, rather than collapsing — the panel below would
otherwise jump every time a chord stopped sounding.

## The sound mix: two channels

What the loop is heard with is two channels, the **song** and the **piano**,
each on or off at its own level (`core/sound-mix.ts`, stored as four fields in
`chordSoundConfig`, read by `useSoundMix()`). Each is set on the thing it
belongs to, by one `<SoundChannelControl channel/>`: the song's on the song
card, the piano's on the keyboard card. There is no "song / piano / mix"
switch — "piano only" is simply the song turned off, and "mix" both on. The
mockup that settled this is the `split` variant of `proto-1789461303-updb`.

| channel | on | off |
|---|---|---|
| song | the YouTube player at its volume | the player **muted, still playing** |
| piano | each box's chord struck as the song's playhead enters it, held for the rest of the box | the piano does not follow the song |

The song is never paused for being off, because its playhead is the clock the
piano follows (the trainer's `usePianoFollow`). The piano stops when the song
pauses, and strikes the box under the playhead again when it resumes. It plays
before the check too — hearing the bare chords under the record is the point —
but it writes nothing the keyboard reads, so it gives no answer away.

What the piano channel does NOT gate: a chord button, a wrong box's struck answer and a
key of the keyboard always sound on the piano — they are the learner asking
for that sound, not the piano following the song. The piano's **level** applies
to all of them (one gain node in `usePiano`).

An answer box always replays its bars of the SONG (`playRange`), heard through
whichever channels are on: the record, the piano following it, or both.

Moving the slider of an off channel turns it on, and the level of an off
channel is kept (dimmed, reading "off") for when it comes back. The slider's
saves are throttled leading + trailing with a held draft
(`web/internal/use-level-fader.ts`), the policy of Sonata's track faders.

## One memory of what was heard

The card is handed ONE chord, `shownChord`, which is simply the last chord
heard — `session.lastPlayed`. Every way of sounding a chord writes it: a button,
a box, the "you" tag, and the playhead crossing into a box while the checked
loop runs (a `useEffect` on the sounding position, which is what makes the
playhead just another writer rather than a special case that outranks the
others).

That single memory is what lets a chord clicked DURING playback light the
keyboard: the click is more recent than the box behind it, so it holds the
keyboard until the song reaches the next chord, and then the song takes it back.
The earlier version asked the playhead first and fell back to the last click,
which meant a click during playback did nothing at all.

## `usePiano`

One `AudioContext` and one voice set for the screen, created inside the first
click that asks for a sound (so the samples download late and the context is
born in a user gesture), reused after, disposed on unmount. Sonata's default
instrument, read generically off `SonataAudio.Instrument` — never by name.

It lives here rather than in `trainer` because the card needs it too, and two
hook instances would open two contexts. The trainer holds the one instance and
hands the card a `play` function; the card does not reach for its own.

## What lives elsewhere

The naming is `vocabulary` (`songVocabulary`, `songKeyLabel`, `songKeyTonicPc`)
and so is `chordSound` itself — this plugin owns the instrument, not the theory.
Only `trainer` imports it, and nothing imports `trainer`, so there is no cycle.

## e2e

`trainer/e2e/trainer-verify.ts` checks the values (the lit `data-pitch` set
against `chordSound` computed in the script, and that the doubled bass is drawn
as the bass). `e2e/piano-shot.ts` checks the *look*: it fills and checks a
round, clicks a chord, and photographs the card with its keys lit and then with
one held down — the one thing a value check cannot tell you.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The Chord app's piano: usePiano (one AudioContext and one voice set per screen, striking a chord or a single note on Sonata's default instrument), <PianoCard> — the four-octave keyboard drawing the chord on show, its doubled bass greyed beside it, playable key by key — and the sound mix: the song and the piano as two channels, each on or off at its own level (useSoundMix, <SoundChannelControl channel/>), the piano following the song's playhead when on. The Chord app's piano, server side: registers the chord-sound config (the song and the piano, each on or off at its own level) so the learner's mix persists and shows in Settings.
- Web:
  - Contributes: `ConfigV2.WebRegister` "config"
  - Uses:
    - `apps/chord/vocabulary.ChordNumeral`
    - `apps/chord/vocabulary.chordToneStyle`
    - `apps/sonata/audio/instruments.InstrumentVoices`
    - `apps/sonata/audio/instruments.SonataAudio`
    - `apps/sonata/primitives/keyboard.Keyboard`
    - `config_v2.ConfigV2`
    - `config_v2.useConfig`
    - `config_v2.useSetConfig`
    - `primitives/css/card.Card`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/slider.Slider`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.cn`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useEventCallback`
    - `primitives/latest-ref.useLatestRef`
  - Exports (types): `Piano`
  - Exports (values):
    - `PianoCard`
    - `SoundChannelControl`
    - `usePiano`
    - `useSoundMix`
- Server:
  - Contributes: `ConfigV2.Register` "config"
  - Uses: `config_v2.ConfigV2`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/chord-palette --chord-outside`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
    - `ui/tokens/type-scale --font-weight-bold`
    - `ui/tokens/type-scale --font-weight-semibold`
  - Imported by: `apps/chord/trainer`
- Core:
  - Exports (types):
    - `ChannelLevel`
    - `SoundChannel`
    - `SoundMix`
  - Exports (values):
    - `MAX_VOLUME`
    - `SOUND_CHANNELS`

<!-- AUTOGENERATED:END -->
