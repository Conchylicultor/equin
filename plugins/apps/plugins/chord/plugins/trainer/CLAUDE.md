# trainer

The Chord training loop: the round model (`core`) and the trainer screen, the
app's index pane at `/chord` (`web`). Design:
`research/2026-09-18-apps-chord-trainer-app.md` ("How a round works"); look:
the prototype `proto-1789461303-updb` at its default options.

## core

- `roundFromCandidate(candidate, { videoDurationSeconds })` turns a
  `find` loop candidate into a round: the loop in video seconds, the beat grid,
  and one answer box per sounding chord of the window. A chord ringing in from
  before the window, or running past its end, is clipped to it; a rest is a gap
  with no box; a repeated chord is two boxes, never merged (user decision).
  The boxes use the index's own overlap rule (`chordOverlapsWindow`), and a
  count different from the window's `chordCount` throws.
- A video-fraction alignment needs the video's length: the player's when it has
  loaded (it wins), else the candidate's. With neither, the result is
  `needs-duration`. An alignment of `none` throws: `find` never returns one.
- Answer time: a box's clock starts the first time its chord finishes sounding
  in the round; `clampAnswerMs` bounds the time to 0.3–30 s.
- `gridBoxes(candidate)`: the same boxes on the beat grid alone (no seconds),
  readable before the video's length is known; `roundFromCandidate` places them
  in the video.
- **Dealing a loop** (`deal.ts`): `dealLoop(candidate, { practised, blanks,
  random? }) → { candidate, asked, blanks }` — the asked positions
  (`askedPositions`, curriculum) decided ONCE, `random` draws included, and
  carried with the queued loop, so the round on screen is frozen: a selection
  change never deals it again.
- **The answer sheet** (`sheet.ts`), pure. `emptySheet(round, asked)` takes the
  positions the learner must name — the dealt loop's `asked` (empty, out of
  range or repeated throws). An answer is a chord or `"rare"` (the Rare joker);
  `sheetScore(sheet, round, listed)` judges with progress's `isRightAnswer`,
  `listed` being the catalog's word on a chord. The other boxes are
  **given**: they come already filled with their own chord and cannot be
  selected, cleared or refilled, so the arrows step over them and Backspace
  reaches past them. The first asked box starts selected; a fill writes the
  selected box and moves to the next empty box after it (else the first empty
  one) — always an asked box, since a given one is never empty; the fill that
  leaves none empty checks the sheet, which then never changes. A changed
  answer keeps its last fill's time. `sheetScore` counts asked boxes only, and
  `recordRoundBody` (the body of `POST /api/chord/rounds`) sends only their
  answers, with the given boxes as `givenCount`.
- **When a chord has finished sounding** (`heard.ts`): `finishedBoxes(boxes,
prev, next)` between two playhead reads — a forward move finishes every box
  whose end it crosses (within 50 ms), a jump back (the loop wrapping) finishes
  the box it cut off within 0.3 s of its end. A box filled before its chord
  finished counts the minimum, 0.3 s.
- **How often each practised chord turns up** (`loop-share.ts`; no forced
  target). `desiredShare(standing)`: 0.50 while new, falling linearly to 0.15
  as `answers/20 × accuracy` grows, 0.15 once mastered — never 0.
  `DesiredShares` holds one per listed practised chord, plus one pooled `rare`
  share for the practised chords no track lists (they count as one key,
  `"rare"`). `pickNext(pool, history, desired, random?)`: of the pool, the loop
  that leaves the observed shares (the last `SHARE_HISTORY` = 20 dealt loops
  plus `PRIOR_LOOPS` = 5 loops of prior at the desired share) closest to the
  desired ones — least sum of squared gaps; ties broken at random.
  `shareDeficits(history, desired)`: the keys furthest below their share, for
  the focused batches. A simulated-stream test checks a new chord settles near
  50 % and mastered ones near 15 %.

## web

`trainerPane` (route `chord-trainer`, segment `""`, `appIndex`) renders
`<SongIndexGate><TrainerScreen/></SongIndexGate>`.

- **Everything comes from the learner's selection** (`useCurriculum`) **and
  the catalog** (`useCatalog`): which chords are practised, heard or off, the
  blanks (all / all but first / random half / last half), how many other chords a loop may
  hold, and which practised chords no track lists (answered by the Rare
  button). Until both land — a `not-ready` catalog included — the screen shows
  its loading state: buttons that are about to change would be a claim about
  what this learner chose.
- **The loop queue** (`useLoopQueue`) holds the round on screen and a
  **pool**. When the pool holds 3 loops or fewer it is refilled in parallel:
  one unfocused `find` (every chord on as `playable`, the practised ones, the
  `extras`, the `phrase` shape — 4 or 8 bars, rich progressions first; see
  song-index; 10 loops) plus one focused `find` (5 loops) for each of the at most
  2 chords furthest below their share (`shareDeficits`; for the pooled rare
  chords, one of them at random). The sections of the last 20 loops moved
  past, of the round and of the pool are left out. Each next loop is
  `pickNext(pool, history, desired)` — `desired` from each practised chord's
  standing (`desiredShare`), the history the chords of the last 20 dealt loops
  — and the other windows of its song section leave the pool. Nothing is asked
  until the progress has loaded, and nothing at all while no chord is
  practised ("No chord is practised"). An empty answer shows "No song fits
  these chords yet" (with Try again), never a blank screen; `not-ready` and a
  failed query show in the same place.
- **The round on screen is frozen.** Each loop is dealt ONCE (`dealLoop`): its
  asked boxes are decided then — a `random` draw included — and stored with
  it, and the round's key is the loop alone, so no selection change ever deals
  it again. **Any change of the chords or the extras empties the pool** behind
  the round (derived: the pool is stamped with the palette it was found for)
  and refills it at once; the blanks apply to the next loop dealt. The sections
  already played are remembered across the change.
- **Which boxes the round asks about** (`askedPositions`, curriculum, via
  `dealLoop`): only a practised chord's box can be blank; `all` every
  practised box, `random` half of them (rounded up), `half` those in the second
  half (else the last practised box). The rest are **given**: they show their
  chord in its own colour, dimmed and flat, are not click targets before the
  check, and are never marked right or wrong. After the check they replay their
  stretch of the song like any other box, because they are part of the loop.
  The heading counts asked boxes only ("Chord 1 of 2"). The round is saved with
  the blanks it was dealt with.
- **The Rare joker.** Practised listed chords have their buttons; when at least
  one practised chord is one no track lists, one **Rare** button follows them —
  there whenever such a chord is practised, so it gives nothing away — with its
  own key, the next digit after the plan's highest (`rareKeyFor`; 0 if none is
  left). A box answered Rare shows "Rare"; checked, it is right when the chord
  is not listed (`isRightAnswer`, the server's rule). A box answered Rare that
  was a listed chord shows the real chord with "Rare" struck beside it (nothing
  to play: Rare is not one chord); a listed answer for a rare chord is simply
  wrong.
- **The player** stays mounted from loop to loop (a new video loads in place).
  Browsers block sound until the page is used, so the first loop waits for Play;
  after a Play or a Next every loop starts by itself (`autoplay`).
- **Answer timing** (`useHeardClock`): watches the playhead, one read per
  animation frame while the video plays, and stamps each box the first time its
  chord finishes. Nothing re-renders for it.
- **Keys** (surface-scoped, `useSurfaceShortcuts`; `useChordKeys`): the chord's
  root digit answers (`chordKeyPlan` over the practised listed chords, so ♭VII
  is on the 7), and the Rare key answers Rare. A digit several
  practised chords share instead **arms** — those chords light, numbered on their
  buttons, and the next number picks one; Escape drops the pick, and so does
  every other key of the trainer. While a digit is armed **it owns the number
  keys**: the plan's own digit shortcuts stand down and the registered numbers
  are exactly the ones `pickPage` says are in reach, so every number key means
  "the chord I lit", not only the ones that happen to hold a chord themselves.
  Past seven chords on one digit, `pickPage` keeps key 7 as the pager: six in
  reach, the rest one press away, wrapping — so no chord is ever unreachable.
  The hook holds only `{ digit, page }`, derived against the plan, so an undone
  step disarms with nothing to clean up. The clock does not stop for the second
  key: a two-stroke answer costs what it costs. ← / → move, Backspace clears,
  Space plays or pauses, Enter moves to the next song.
- **The sound mix** (`piano/web`'s `useSoundMix`): the song and the piano,
  each on or off at its own level, set on the song card and the piano card.
  The song's level and mute go to the player's `audio` prop (off = muted, still
  playing). With the piano on, `usePianoFollow` watches the playhead and strikes
  each box's chord as the song enters it, held for the rest of the box; it
  silences the piano when the song stops, and strikes again on resume. A
  playhead that moves while the song is not playing (the video cued at the
  loop's start when the screen opens) strikes nothing. It plays
  before the check too, and writes nothing the keyboard reads.
- **After the check**: a box plays its bars of the song once
  (`controller.playRange`), heard through whichever channels are on. A chord button, or the struck answer inside a
  wrong box, always plays on the piano (`chordSound(token, tonicPc)`), because
  neither chord need be in the loop at all. The button of the chord sounding now
  is lit.
- **The round is saved once**, by the fill that checks it
  (`recordRoundEndpoint`). A round left before it is checked is never sent.
- **Video reports** (`reportPlaybackEndpoint`): `playing` the first time a
  video plays in the visit; a player error with its code — then a toast says
  the video can't play here, and the trainer drops that loop and every queued
  loop on the same video.
- **The piano** (`piano/web`): `usePiano` is Sonata's default instrument (the one
  `SonataAudio.Instrument` contribution marked `default`, the sampled grand),
  read generically, never by name. One `AudioContext` and one voice set per
  screen, created by the first chord played (inside that click, so it starts
  running, and the samples download only then), disposed on unmount. Each chord
  cuts the one before it. A failure (no default instrument, samples that do not
  load) shows a toast and is rethrown. The screen holds the ONE instance and
  hands `<PianoCard>` a `play` function, so the card's playable keys sound on
  the same context rather than opening a second one.
- **The progress panel** (`ProgressPanel`): today (songs, % right, seconds per
  chord), an all-time line, "Your chords" — one line per listed chord that is
  on, in catalog order (`catalogOrder`: track, section, share; chip, accuracy
  meter marked at 90 %, accuracy, median time red over 2 s, a check once
  mastered; a chord only heard is dimmed and reads "hear only"), plus one
  **Rare** line from the pooled standing (`chord.progress`'s `rare`) when a
  chord no track lists is on — and the Chords section (`<ChordsSection>`,
  curriculum), which holds every practice control. The panel hands it a
  `standing` lookup built from `chord.progress` and `desiredShare`. The
  progress read covers EVERY listed chord of the catalog (`tokens`), whatever
  is on, so a chip click never re-keys it (no loading flash, the round stays
  mounted); the server pools every unlisted chord as `rare` itself. It is a **plain component, not a DataView**:
  a small fixed status list, not a collection anyone searches, sorts or
  filters. It shows a loading state until `chord.progress` has its first value.
- **The words, and the piano** (`piano/web`): one `songVocabulary(songKey)` and
  one `songKeyTonicPc(songKey)` per loop, so nothing on screen names a chord
  against one key while sounding it against another. Every chord is named — the
  song card carries a key tag, each box a name under its numeral, each button a
  name instead of its function word — and `<PianoCard>` sits under the buttons,
  always. (There used to be a three-valued `reveal` setting gating all of this;
  it is gone, and with it every `| null` name prop.) A box's name follows the
  same `shown` the numeral does, so before the check it names the LEARNER's
  answer and leaks nothing.
  **`shownChord` is the one chord on show**, fed to the lit button and the piano
  together, and it is simply `session.lastPlayed` — the last chord HEARD.
  Everything that sounds a chord writes it: a button, a box, a wrong box's struck answer,
  and a `useEffect` on the sounding position, so the playhead crossing into a
  box is just another writer rather than a special case outranking the others.
  That is what lets a chord clicked DURING playback light the keyboard: the
  click is more recent, and holds until the song reaches the next chord. It is
  null before the check **by construction** (nothing writes `lastPlayed` until
  then), which is what stops the keyboard giving the answer away; `lastPlayed`
  is a `RoundSession` field, so the next song clears it with the rest and there
  is no reset to remember.

### Paint

`web/components/trainer.css` holds the bespoke paint only — box states
(`data-given`, `data-filled`, `data-selected`, `data-mark`, `data-now`,
`data-pop`), the box's name line (`.chord-box-name`), the chord buttons
(`data-lit`, `data-picking`, the dimmed pager badge), meters, the
numeral's display sizes (which the type scale has no rung for, and one of which
follows the box's width through a container query). Layout stays with the
layout primitives: the boxes, ruler ticks, playhead and badges are placed by
runtime numbers (`placedStyle`, a fraction of the window's beats), rows are
`Line` + `Fill`, the page's two tracks are the one raw grid (a container query
at 1000 px, with a named disable).

A chord's own colour and numeral are drawn the same wherever they appear, so
they live with the shared chord box (`music/chord-box`: `<ChordBox>`,
`chordPaint`, `chord-box.css`, used through vocabulary's `chordToneStyle` and
`<ChordNumeral>`) and the curriculum's Chords section (its chips) draws them
too.

## e2e

`e2e/trainer-verify.ts` (its round played with the digits of the practised
chords; the Chords section and the Rare joker are `curriculum-verify.ts`'s):
the index reaches ready; /chord shows a round whose
heading counts its **asked** boxes (the given ones name themselves, ", given",
which is how the script tells them apart); Play leads to a playback report
(playing or an error — headless Chromium may not play YouTube); every asked box
is filled from the keyboard, using only digits that answer on their own; the
score heading, the saved round, `chord.progress` (one more song, one more
answer per asked box) and the side panel's all-time line are checked.

Then the key tag is parsed back into the key it names, every box label is
checked for a letter name, and the lit keys' `data-pitch` set must equal
`chordSound(token, tonicPc).pitches` computed in the script — the proof that the
picture matches the sound, since the piano plays that same call — with the
doubled bass drawn as the bass (`[data-bass]`) rather than as a fourth chord
tone. Clicking the button to light them also plays it, so the step exercises the
piano.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The Chord trainer screen, the app's index pane (/chord): a real song's loop in an embedded YouTube player, an answer strip with one box per chord on the beat grid, one button per practised chord (keys 1–7), the check with its score, replays of the song over a box and of chords on Sonata's piano, the saved round, the player's playback reports, and the progress panel (today, all time, your chords).
- Web:
  - Slots: `chord-trainer.actions`
  - Slot contributors: `chord-trainer.actions` ← `primitives.pane`
  - Contributes: `Pane.Register` "chord-trainer"
  - Uses: 53 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `integrations/youtube` ×5
    - `apps/chord/curriculum` ×4
    - `apps/chord/piano` ×4
    - `primitives/live-state` ×4
    - `primitives/css/coords` ×3
    - `primitives/pane` ×3
    - `apps/chord/vocabulary` ×2
    - `infra/endpoints` ×2
    - `music/chord-box` ×2
    - `primitives/css/spacing` ×2
    - `primitives/css/ui-kit` ×2
    - `primitives/latest-ref` ×2
    - `apps/chord/song-index.SongIndexGate`
    - `network/live.useLive`
    - `primitives/css/card.Card`
    - `primitives/css/center.Center`
    - `primitives/css/clip.Clip`
    - `primitives/css/fill.Fill`
    - `primitives/css/grid.Grid`
    - `primitives/css/inline.Inline`
    - `primitives/css/line.Line`
    - `primitives/css/overlay.Overlay`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/text.Text`
    - `primitives/css/yield.yieldClass`
    - `primitives/loading.Loading`
    - `primitives/overlay/tooltip.Kbd`
    - `primitives/shortcuts.useSurfaceShortcuts`
    - `shell/toast.showToast`
    - `ui/icons.Icon`
- Core:
  - Uses:
    - `apps/chord/curriculum.askedPositions`
    - `apps/chord/curriculum.Blanks`
    - `apps/chord/progress.Answer`
    - `apps/chord/progress.isRightAnswer`
    - `apps/chord/progress.MASTERY_WINDOW`
    - `apps/chord/progress.MasteryStanding`
    - `apps/chord/progress.RecordRoundBody`
    - `apps/chord/song-index.beatTimesAlignment`
    - `apps/chord/song-index.BeatTimesAlignment`
    - `apps/chord/song-index.beatToSeconds`
    - `apps/chord/song-index.chordOverlapsWindow`
    - `apps/chord/song-index.ChordToken`
    - `apps/chord/song-index.LoopCandidate`
    - `apps/chord/song-index.LoopShapeId`
    - `apps/chord/song-index.resolveVideoFraction`
    - `integrations/hooktheory.hookpadTonicPc`
  - Exports (types):
    - `AnswerSheet`
    - `Box`
    - `DealtLoop`
    - `DesiredShares`
    - `GridBox`
    - `Round`
    - `RoundResult`
    - `ShareKey`
    - `SheetScore`
  - Exports (values):
    - `ANSWER_MS_MAX`
    - `ANSWER_MS_MIN`
    - `boxAt`
    - `clampAnswerMs`
    - `clearBackward`
    - `dealLoop`
    - `desiredShare`
    - `emptySheet`
    - `fillSelected`
    - `FINISH_EPSILON_S`
    - `finishedBoxes`
    - `gridBeatAt`
    - `gridBoxes`
    - `loopShareKeys`
    - `MASTERED_SHARE`
    - `moveSelection`
    - `NEW_SHARE`
    - `observedShares`
    - `pickNext`
    - `PRIOR_LOOPS`
    - `recordRoundBody`
    - `roundFromCandidate`
    - `selectBox`
    - `SHARE_HISTORY`
    - `shareDeficits`
    - `sheetScore`
    - `WRAP_TOLERANCE_S`

<!-- AUTOGENERATED:END -->
