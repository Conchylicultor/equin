# Chord trainer — the app: skeleton, training loop, progress

Track page: `block-49ba706c-affe-417b-a9a1-b6873e8c7ea8` ("Chord trainer app").
Builds on the song index ([v4](2026-09-17-apps-chord-trainer-song-index-v4.md),
load on first use in [v3](2026-09-17-apps-chord-trainer-song-index-v3.md)) and
[video availability](2026-09-18-apps-chord-video-availability.md). Mockup:
prototype `proto-1789461303-updb`.

## Context

The index can already answer "give me 4-bar loops of real songs whose chords are
all unlocked and include the chord I'm learning", and it leaves out videos known
not to play. But there is no app to open. Nothing plays a loop, asks for the
chords, checks the answers or remembers how the learner is doing. And nothing
sends the player's reports, so the videos that are blocked in this region, or
that refuse to play on other sites, still get offered.

Outcome of this step: a **Chord** app in the rail. Opening it starts the index
load and shows its progress. Then it plays a loop from a real song on repeat,
and you name each chord by filling one box per chord. Once every box is filled,
the answers are checked, and you can compare the song with your answer. Every
answer is saved. A side panel shows today's totals and how well you know each
chord.

**Out of scope:** the curriculum (which chords unlock, in what order). A fixed
starting set drives the loop for now: I, IV and V, root-position major triads,
in major keys. Also out: the mockup's "reveal" options (chord names, keyboard),
which are the track's `[later] Show the real chords` item. And the locked
"next chord" teaser, which belongs to the curriculum.

## Decisions (user, 2026-09-18)

- **Hear the difference: the song plus a piano.** After checking, clicking a box
  replays the real song over just that box. Clicking a chord button, or the
  "you: IV" tag under a wrong box, plays that chord on a piano in the song's key.
- **The piano is Sonata's sampled grand**, reused through Sonata's instrument
  list. The samples download on the first chord played, then work offline.
- **One box per transcribed chord.** A chord repeated in the transcription (I
  for 2 beats, then I again) gets two boxes. Boxes are never merged.

## What the app looks like

As the mockup at its default options (`palette=onyx`, `chords=classic`,
`tiles=solid`, `reveal=off`). Dark only. "Sonata / Chords" in the header
becomes "Chord". The mockup's palette sheet is not part of the app.

- **Header**: a thin bar with the logo and the app name.
- **Main column**:
  - **Song card**: the YouTube player (small, 16:9, where the mockup has its
    thumbnail), then the title, artist, section and bar count. On the right, a
    Play/Pause button and "Next song ↵".
  - **Answer strip**: one box per chord. Each box is as wide as its chord
    lasts, on a grid of the window's beats, with a ruler of beat and bar ticks
    under it and a playhead crossing the box that is sounding. The heading reads
    "Chord 2 of 6" while you answer, and "5 of 6 right in 1.4 s" once checked.
  - **Chord buttons**: one per unlocked chord. Each shows its numeral (Bodoni),
    a coloured edge (its scale degree's colour), its key (1–7) and its function
    ("tonic", "subdominant", "dominant").
- **Side panel**: "Today" (songs, % right, seconds per chord), then "Your
  chords": one line per unlocked chord with an accuracy bar marked at 90 %, the
  usual answer time (red when over 2 s) and a check once it is mastered. Under
  "Today", a quieter all-time line: songs played, % right.

## How a round works

1. **Pick a loop.** The trainer keeps a small queue of loops. When it runs out,
   it asks `POST /api/chord/loops/find` for 10 more: all starting chords
   unlocked, `modes: ["major"]`, the sections of the last 20 rounds excluded,
   and as `target` the **weakest** unlocked chord (not mastered first, then the
   fewest recent answers, then the lowest accuracy). An empty answer shows "No
   song fits these chords yet", never a blank screen.
2. **Build the boxes** (`roundFromCandidate`, pure, in `trainer/core`):
   - one box per sounding chord in the window, in order. A chord that rings in
     from before the window is clipped to the window's start, and one that
     runs past its end is clipped to the end;
   - a rest is a gap in the grid, with no box;
   - each box's start and end in video seconds, through `beatToSeconds` (after
     `resolveVideoFraction` when the alignment is a video fraction). The video's
     length comes from the candidate, or from the player once it has loaded. The
     loop is `[window start, window end)` in seconds.
   - The candidate schema still allows alignment `none`. `find` never returns
     one (such sections have no windows), so it throws rather than being skipped
     quietly.
3. **Play on repeat.** The player seeks to the loop start and plays. When the
   loop end is reached, it seeks back to the start.
4. **Answer.** The first empty box is selected. Clicking a chord button (or
   pressing 1–7) fills the selected box and moves to the next empty one. Clicking
   a box selects it. ← and → move the selection. Backspace clears the box, or the
   previous one if the box is empty. Space plays or pauses.
5. **Answer time** (as in the mockup): a box's clock starts the first time its
   chord *finishes* sounding in this round. The time is from then until the
   click that filled the box, clamped to 0.3–30 s. If you change an answer, the
   last fill counts.
6. **Check.** When the last box is filled, every answer is marked right or
   wrong, the heading shows the score, and the round is saved in one call
   (`POST /api/chord/rounds`). A round you skip before it is checked is not
   saved.
7. **After checking**, the loop keeps playing:
   - clicking a box plays the song over just that box, once, then goes back to
     looping;
   - clicking a chord button plays it on the piano, in the song's key;
   - under a wrong box, the "you: IV" tag plays your answer on the piano.
   Enter moves to the next song.
8. **Video reports.** The first time a video plays in a session, it is reported
   as `playing`. A player error is reported with its code, and the trainer moves
   to the next loop, saying the video could not play. Both go to
   `POST /api/chord/videos/:videoId/playback`.

Browsers block sound until the page has been clicked. So the first loop waits for
Play. Every loop after that starts by itself.

## Chord names and colours (`vocabulary/core`)

A chord token (`"7:4-3/0"`) is a sound relative to the tonic. The trainer needs
three things from it, all pure functions:

- **A numeral**: the root's scale degree against the major scale (`♭` for a root
  outside it), the quality from the intervals, and an inversion figure (⁶, ⁶₄,
  ⁶₅ …). Reuses Sonata's chord table and `romanNumeral`
  (`@plugins/apps/plugins/sonata/plugins/theory/core`), with C as the tonic,
  because tokens are already relative to the tonic.
- **A colour**: degrees I…vii map to the 7 chord colours, in the mockup's order.
  A root outside the major scale gets a neutral grey.
- **The notes**: the key's tonic plus the token's root, intervals and inversion,
  as a close voicing around middle C (Sonata's `chordPitches` and
  `invertVoicing`).

`STARTING_CHORDS` (I, IV, V: `"0:4-3/0"`, `"5:4-3/0"`, `"7:4-3/0"`) and
`STARTING_MODES` (`["major"]`) sit here too, as the placeholder the curriculum
will replace. Tokens are exact, so a IV in first inversion is a different chord:
loops that hold one are left out until the curriculum unlocks it.

## Progress (`progress` sub-plugin)

### Tables (plain `pgTable`, like the other chord tables)

- `chord_rounds`: `id`, `sectionId`, `videoId`, `shape`, `startBeat`,
  `checkedAt`, `boxCount`, `correctCount`. Indexed on `checkedAt`.
- `chord_answers`: `id`, `roundId` (FK, cascade), `position`, `token` (the chord
  that played), `answer` (the chord you picked), `correct`, `answerMs`,
  `answeredAt`. Indexed on `(token, answeredAt desc)` and on `answeredAt`.

Both are **kept** in worktree forks and in backups (they are the learner's
history, which nothing can rebuild), and they stay in the change feed (it
drives the stats). **No growth bound is declared**, as with `chord_videos`:
rows are created only when a person checks a round, so the table grows only as
fast as someone plays. The plugin's CLAUDE.md says so.

`correct` is computed by the server (`token === answer`), not sent by the client.

### Endpoint

`POST /api/chord/rounds`, body: `{ sectionId, videoId, shape, startBeat,
answers: [{ position, token, answer, answerMs }] }`. It writes the round and its
answers in one transaction.

### Mastery rule (`progress/core`, one function)

`chordMastery(recent)` looks at the last 20 answers for a chord (`MASTERY_WINDOW
= 20`). The chord is mastered when all 20 exist, at least 90 % are right
(`TARGET_ACCURACY`), and the median time is at most 2.0 s (`TARGET_MEDIAN_MS`).
The mockup's rule, stated once and used by both the server and the panel.

### Live stats: `chord.progress`

A plain `resourceDescriptor` with parameters, not a collection:
`{ timeZone, tokens }`, where `tokens` is the unlocked set, sorted and joined by
commas. The web reads it with `useResource(chordProgressResource, params)`. The
server uses `defineResource(…, { mode: "invalidate", identityTable:
"chord_answers", loader })`. `mode` must be written out: the
`keyed-resource-scope` check treats a call without it as the keyed form.

Value:

```ts
{
  chords: { token, answers, correct, medianMs, mastered }[]; // in `tokens` order, last 20 each
  today:   { songs, answers, correct, totalMs };             // since local midnight in `timeZone`
  allTime: { songs, answers, correct };
}
```

Every read is bounded. Per chord, it is one index scan of 20 rows. Today is a
range scan on `answeredAt`. All-time is two counts. Those counts grow with the
history, but at personal scale that is small. Local midnight comes from
`Intl.DateTimeFormat` (today's date in `timeZone`) and `wallClockToInstant`
(`@plugins/packages/plugins/wall-clock`), so the host's time zone never matters.

## The YouTube player (`integrations/youtube`, new, web only)

This is the repo's first player it can control. Nothing in it is chord-specific,
so it lives with the other integrations:

- `loadYouTubeIframeApi()` loads `https://www.youtube.com/iframe_api` once,
  through a single shared promise.
- `<YouTubePlayer videoId segment={{ start, end } | null} …>` and a controller
  (`play`, `pause`, `playRange(start, end)` for one pass, `currentTime`,
  `duration`). Callbacks: `onPlaying`, `onError(code)`, `onReady(duration)`.
- **Looping without polling**: while it plays, one `setTimeout` is set for the
  time left until the loop's end. When it fires, the player seeks back if the
  video really reached the end, and otherwise sets a new timer. The timer is
  reset on every state change (pause, seek, buffering).
- **Playhead**: `useYouTubePlayhead` reads `getCurrentTime()` once per animation
  frame, only while playing. It is animation, not change detection.

The chord trainer turns `onPlaying` and `onError` into playback reports. The
player itself knows nothing about them.

## The piano

The chord buttons and the "you:" tag play through Sonata's instrument list:
`SonataAudio.Instrument.useContributions()`, then the `default` instrument (the
sampled grand), `createVoices(ctx, destination)` on the trainer's own
`AudioContext`, and `voices.schedule(...)` for each note of the chord. This is
the first app outside Sonata to use that list. It was split out of Sonata's
shell for exactly this, but no other app has used it yet, so the lifecycle
(create once per screen, `dispose` on unmount) gets checked in the browser.

## Loading the index

`song-index/web` gains `<SongIndexGate>`. On mount, it calls
`POST /api/chord/index/ensure`, and it reads `chordIndexStatusResource`:

- `loading` shows "Downloading songs…", "Preparing…" or "Loading songs 12,000 /
  26,175", with a progress bar;
- `failed` shows the error and a Retry button that calls `ensure` again;
- `ready` shows the trainer.

It sits in the song-index plugin because that plugin owns the status and the
ensure call. The trainer only wraps itself in it.

## Theme

`ThemeEngine.Theme(chordTheme)`, selected by
`config/ui/theme-engine/@app/chord/theme.jsonc` (`{ "theme": "chord" }`), like
`home` and `website`. The colour palette is written with `both(...)`, so light
mode and dark mode get the same dark values: this is what makes it dark only.

- **Surfaces and text**: the mockup's onyx values mapped onto the colour-palette
  tokens (`#080809` page, `#111113` cards, `#19191C` raised, `#D6D4CF` /
  `#979590` / `#66655F` text, `#62B57A` right, `#E2574C` wrong).
- **Chord colours**: the 7 "classic" hues as `categorical-1…7`
  (`categoricalGroup`). The solid tile fill and numeral colour are derived in
  CSS (`color-mix`), as in the mockup.
- **Fonts**: `fontSans: 'Schibsted Grotesk'`, `fontSerif: 'Bodoni Moda'`. The
  Google Fonts loader already fetches any catalogued family named in a theme,
  and both are in its catalogue, so no package is added. Numerals use
  `font-serif`.

## Layout

```
plugins/apps/plugins/chord/
  web/index.ts                       empty namespace plugin (create-app rule)
  plugins/shell/web/                 Apps.App(chordApp, icon, ChordLayout = header + FullPane),
                                     ThemeEngine.Theme(chordTheme)
  plugins/vocabulary/core/           chordLabel, chordDegreeColor, chordVoicing,
                                     STARTING_CHORDS, STARTING_MODES (+ tests)
  plugins/song-index/web/            + SongIndexGate
  plugins/progress/
    core/                            mastery rule, schemas, recordRoundEndpoint,
                                     chordProgressResource, the param codec (+ tests)
    server/                          tables, record handler, progress loader + resource
    web/                             <ProgressPanel tokens> (Today + Your chords)
  plugins/trainer/
    core/                            roundFromCandidate, answer timing (+ tests)
    web/                             trainerPane (appIndex), TrainerScreen, SongCard,
                                     AnswerStrip, ChordButtons, useLoopQueue,
                                     usePiano, TrainerShortcuts (useSurfaceShortcuts)
    e2e/                             trainer-verify.ts
plugins/integrations/plugins/youtube/web/   the player
config/ui/theme-engine/@app/chord/theme.jsonc
```

Dependencies only point one way: trainer imports progress, vocabulary,
song-index, video-availability, youtube and Sonata's theory and instruments.
Shell imports only its own core. The trainer registers its own pane.

"Your chords" is a small fixed status list inside the trainer (at most about
30 chords), not a collection to browse. It is a plain component, not a
DataView, and the trainer's CLAUDE.md says why.

## Build order

1. `vocabulary/core` + tests: numerals for the common qualities and inversions,
   degree colours, voicings.
2. `trainer/core` `roundFromCandidate` + tests: a chord ringing in from before
   the window, one running past its end, a rest, a repeated chord (two boxes),
   3/4 and 6/8 windows, both alignment kinds, answer-time clamping.
3. `progress`: tables, endpoint, mastery rule + tests, the resource loader + a
   `worktree-db` test (last-20 window, today's cutoff across a DST change,
   all-time counts).
4. `integrations/youtube` player.
5. `shell/web`, theme and its config, `SongIndexGate`.
6. `trainer/web`: the screen, queue, piano, shortcuts, reports.
7. CLAUDE.md for each new plugin; update `chord/CLAUDE.md` and the two lines in
   `video-availability/CLAUDE.md` that say "nothing sends reports yet".
8. Track page: an update card and the Progress list. Then a follow-up task for
   the curriculum, with the page id and `block-361815ed-5750-413a-b5ab-31c5dc855144`.

## Verification

1. `./equin test plugins/apps/plugins/chord` (vocabulary, round model,
   mastery, progress loader).
2. `./equin build` (background): migrations, boundaries, type-check, docs.
3. Screenshot `/chord` on this worktree (`screenshot.ts --path /chord`). On a
   fresh worktree DB it shows the loading phases, then the trainer.
4. `e2e/trainer-verify.ts` against the deploy:
   - the index reaches `ready`;
   - a loop loads, and there are as many boxes as the round has chords;
   - press 1/4/5 to fill every box; the check shows the score;
   - `query_db` shows one new `chord_rounds` row and its `chord_answers` rows;
   - the side panel's numbers move;
   - `chord_videos.playerCheckedAt` is set for the video that played (or its
     error code is recorded, if headless Chromium cannot play it).
5. Check by hand in a real browser, since headless playback of YouTube is not
   reliable:
   - the loop repeats at the right place;
   - the playhead follows the song;
   - clicking a box plays just that stretch of the song;
   - the piano plays the chord in the song's key;
   - a known region-blocked or embedding-disabled video is reported and
     skipped.
6. `compare-diff.ts --name proto-1789461303-updb` if the mockup declares that it
   mocks `/chord`, to compare the look side by side.

## Left open

- **Headless YouTube.** Chromium under Playwright may refuse to play YouTube
  (codecs, autoplay). If so, the e2e script checks the report path through the
  error branch, and real playback is checked by hand.
- **The "today" boundary** follows the browser's time zone. A learner who
  travels sees "today" change with them, which seems right.
