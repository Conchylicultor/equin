# Sonata — UG alignment C: the YouTube video as the clock, picked automatically

Task C of [`2026-09-29-apps-sonata-ug-sheet-alignment.md`](2026-09-29-apps-sonata-ug-sheet-alignment.md).
It builds on A (beat features, `infra/audio-analysis`) and B (the aligner, the
record and the job,
[`2026-10-01-apps-sonata-ug-alignment-aligner.md`](2026-10-01-apps-sonata-ug-alignment-aligner.md)).

## Context

After B, a UG song with a hand-pasted YouTube link compiles to a `Score` on the
recording's real beats: Score beat 0 is t = 0 s of the video, and the Score is at
sounding pitch. Two gaps remain:

1. **Play.** Sonata only plays its synth, on the AudioContext clock. The recording
   is a link in the Recording section and is never heard in sync.
2. **Pick.** The user has to find and paste the video.

Done when 10 varied songs imported with no video given are reported: how many
landed on the right recording, and a by-ear check of the synth over it.

## Facts the design rests on

**Session transport** (`sonata/session/web/session.tsx`):

- `TransportClock` is `{ now(): seconds }`, held in a single slot by
  `registerClock` (last registration wins). The unregister restores the
  *wall clock*, not the previous clock. The audio engine registers
  `ctx.currentTime`.
- The rAF tick computes `rawSec = clock.now() − anchor.startClockSec + anchor.startScoreSec`.
  It folds the A-B loop (`foldLoopTime`) and writes the cursor.
- `seekTo` bumps `seekEpoch`.
- `tempoScale` is baked into the `score` (`scaleTempo`), and a layout effect
  re-anchors on every score change.
- Count-in and metronome read `ctx.currentTime` directly.

**Synth** (`audio/engine/web/scheduler.ts`):

- A 40 ms look-ahead pump on `ctx.currentTime`, anchored as
  `audioAnchor = ctx.currentTime` and `fromBeat = cursor.getBeat()` at play.
- The anchor is rebuilt on `[isPlaying, seekEpoch, loopKey, …]` and retimed on
  a `score` change.
- It schedules loop iterations ahead, with no teardown.

**YouTube player** (`integrations/youtube/web`):

- `useYouTubePlayer()` gives play, pause, seek, playRange, its own loop,
  `subscribePlayhead` (one rAF read while PLAYING, extrapolated at most 0.5 s by
  wall time × rate) and the state `loading | ready{playing} | error{code}`.
- `audio={{volume, muted}}` is supported. Muted keeps time.
- **No `setPlaybackRate`.**
- A seek on a CUED video starts it.
- The iframe dies on unmount.
- The Chord trainer is the reference consumer: the video leads, and the piano is
  struck as the playhead enters a chord box.

**Score and player:**

- `Score` has no notion of a recording. `mergeScores` takes `tempoMap` from the
  first score that has one.
- A collapsed `Sonata.Section` body is unmounted.
- The library's now-playing bar plays with no `PlayerDisplay` mounted.

**Alignment** (`ultimate-guitar/plugins/alignment`):

- The row is `{videoId|null, status queued|running|aligned|weak|failed, phase analysing|aligning, error, errorPermanent, record}`.
- One supervised job `sonata.ug-alignment.align` (lock = songId), with the pure
  `decideWork`.
- `PUT …/alignment/video {url}` sets the video.
- The `sonata.ug.tabSaved` trigger re-aligns only when a row with a video exists.
- `WEAK_MATCH_THRESHOLD = 0.5`. Right recordings score 0.70–0.91 and wrong ones
  at most 0.34.

**Candidates:**

- **Hooktheory.**
  - `apps/chord/song-index`: the `chord_sections` table has `artist`, `song`,
    `artistSlug`, `songSlug`, `videoId` and `videoDurationSeconds`, one row per
    section.
  - It has no artist/title lookup and no slug index, and nothing outside
    apps/chord reads it.
  - It loads only once the Chord app was opened (`chord_index_request`), and a
    worktree holds a 1/20 sample.
  - The Hooktheory *API* cannot search by artist or title, so the dump is the
    only artist → video map.
- **YouTube search.**
  - There is no YouTube search in the repo.
  - `audio-fetch` has the `youtube-audio` uv project (yt-dlp + yt-dlp-ejs, bun as
    JS runtime) and `runPython(ready, {module, input, output})` with JSON in and
    out. That needs an `ExecContext`, so it runs in a supervised job body.
- **Embeddability.** `apps/chord/video-availability`'s `checkOembed` (200 → ok,
  401/403 → not-embeddable, 400/404 → gone, 2 s timeout) lives in chord, with a
  `chord_videos` ledger.
- **Matching.** There is no reusable artist/title normaliser or fuzzy matcher.

## Part 1 — Play: the video as the transport

### The Score names its recording

- Add `Score.meta.recording?: { provider: "youtube"; videoId: string; durationSec: number }`.
  - Its contract: at tempo scale 1, score seconds equal media seconds
    (`beatToSeconds(score, b)` is the video time of beat `b`).
  - `alignedScore` sets it from the record.
  - This names a timebase, not an alignment, so no display learns about
    alignment.
- `mergeScores` takes `recording` from **the same score that supplied
  `tempoMap`**. The two must travel together, since the mapping is only true for
  that tempo map.
- `scaleTempo` keeps `recording`. A consumer divides media seconds by the tempo
  scale.

### A transport driver in the session (replaces "register a clock")

A clock that only answers `now()` cannot express what a video needs. The video
seeks, buffers, pauses on its own, and can refuse to play. So the session gets a
**transport driver** seam: an external medium that *owns* position, beside the
internal anchored clock.

```ts
// sonata/session/web
interface TransportDriver {
  /** Score seconds at the current tempo scale, or null while not advancing (buffering, seeking, cued). */
  position(): number | null;
  play(): void; pause(): void;
  seek(scoreSec: number): void;
  /** Ask for a rate; resolves to the rate the medium actually took. */
  setRate(rate: number): Promise<number>;
  /** Pushes advancing / stalled / paused-externally / failed. */
  subscribe(listener: (s: DriverState) => void): () => void;
}
registerTransportDriver(driver): () => void   // a stack: unregister restores the previous one
```

- **No driver** (today): the anchored clock, unchanged.
- **With a driver:**
  - **Tick.** The rAF tick reads `driver.position()` and converts it to a beat.
    There is no anchor arithmetic, and `null` freezes the cursor.
  - **Transport calls.** `play` / `stop` / `seekTo` call through to the driver.
  - **A-B loop.** When the tick sees the position cross B, it seeks the driver to
    A and writes the cursor with `{seek: true}`. A video cannot fold seamlessly,
    so the wrap costs a short YouTube seek, which is accepted.
  - **Tempo.** `setTempoScale` calls `driver.setRate(scale)` and adopts the rate
    it returns, so YouTube's steps (0.25–2) win and the UI never shows a speed the
    video is not playing. `0` pauses.
  - **External pause.** The driver reports it, and `isPlaying` follows. There is
    no hidden divergence.
- `registerClock` keeps serving the audio engine, but its unregister becomes
  "restore the previous clock", which fixes the single-slot bug the stack exposes.
- A driver also exposes a `syncEpoch` on the session, which bumps on every
  stall→advance transition and every driver seek.
- **Count-in.** While a driver is registered, `playWithCountIn` plays without a
  count-in (the metronome's count-in is anchored on `ctx`). This is a recorded v1
  limit. The recording usually has its own intro.

### Synth slaved to the video

The synth stays a look-ahead scheduler on `ctx`, since `ctx` is the only
sample-accurate clock. Only its anchor comes from the driver:

- **Rebuild.** The rebuild effect also keys on `syncEpoch`. On advance it anchors
  `audioAnchor = ctx.currentTime + outputLatencyComp` and
  `fromBeat = secondsToBeat(driver.position())`. While stalled it cancels and
  calls `allOff()`.
- **Drift.** In the rAF tick (render cadence, not polling), compare the
  scheduler's implied score position with `driver.position()`. Past ±40 ms,
  call a new `handle.resync(beat, ctxTime)`. It is `retime`'s sibling: it moves
  the anchor without cutting ringing notes.
- **Smoothing.** `driver.position()` is the YouTube controller's playhead put
  through a smoothing clock (below), so resyncs are rare. They should come from
  real slips, not from iframe jitter.
- **Sync offset.** A user-tunable sync offset (ms, default 0, persisted) is
  added on the synth side to cover the iframe's audio latency. The by-ear check
  sets its default.

### YouTube integration additions (`integrations/youtube/web`)

- **Rate.** `setPlaybackRate(rate) → Promise<number>`, which reads back
  `getPlaybackRate()` after `onPlaybackRateChange`. Declare it in `iframe-api.ts`.
- **Media clock.** `createMediaClock(controller)` returns `{ position(): number | null }`.
  - It holds a linear model `(perfAt, mediaAt, rate)`.
  - It refits on each distinct raw `getCurrentTime()` and slews toward it, at no
    more than 5 % of rate, while the error is under 150 ms.
  - It snaps on a larger jump (a seek).
  - It answers `null` unless the state is PLAYING.
  - It is generic, and a pure core function where possible (unit-tested with
    synthetic raw samples).
- **Seek before play.** Fix the documented "seek on CUED starts playback" by
  seeking with `cueVideoById(id, t)` when not playing.

### Sonata's recording plugin (`sonata/plugins/recording`, new)

- **`RecordingStore`** (`SonataSession.Provider`): the mix,
  `{ video: { on, volume }, synth: on }`.
  - The synth level stays the existing master volume. Synth on/off is that
    store's mute, so there is one gain.
  - Video defaults to on at 100, synth on.
  - It is persisted per app via a small config.
- **The video.** *(Revised after review: first built as a `SonataPlayer.Media`
  card above the side column with a minimise state and a `mix` header popover;
  both were removed.)* The plugin exports `RecordingVideo({ videoId })`, and
  the UG alignment's **Recording** section renders it at the top of its body:
  - the video (16:9), then its volume (on/off + slider) directly below, then
    the sync offset (small, under the slider);
  - **synced** when the open score is timed on that video
    (`score.meta.recording.videoId === videoId`): YouTube's controls off, and
    while ready it registers the driver (controller + media clock),
    unregistering on unmount;
  - **not synced** otherwise (a chosen video with no alignment yet, or a failed
    one): YouTube's own controls, drives nothing, labelled "Not synced".
  - The section unmounts its body when collapsed: the driver unregisters and
    playback carries on with the synth alone on its own clock, from where the
    cursor was. Its open state is seeded open for a song that plays on a video.
- **Errors.** A player `error {code 100 / 101 / 150}` is a refusal: the section
  shows it and reports it to the resolver (Part 2). Any other code (2 — an
  invalid parameter, our bug — and 5) is shown as a player error and never
  reported.
- **Mix.** The synth's level is the engine's plain header volume control. The
  video's sound, level and the sync offset are the `sonata.recording` config.

## Part 2 — Pick: automatic video resolution

### A neutral lookup: `integrations/youtube/plugins/song-videos` (new)

The collection-consumer pattern applies: Sonata asks "which YouTube videos are
this song?" without naming who answers.

**Core:**

- `SongQuery {artist, title}`.
- `VideoCandidate {videoId, title, channel, durationSec|null, sources: {source, evidence: "human-synced"|"search", rank}[]}`.
- `SourceAnswer = {kind:"answered", candidates} | {kind:"unavailable", reason}`.
  Not-loaded is a state, never an empty list.
- `normalizeSongKey` handles case, diacritics, "feat.", parentheticals and a
  leading "The".
- `rankCandidates(query, candidates)`, pure and unit-tested:
  - **Channel and title class:** "<Artist> - Topic" > "Official Audio" > "Official
    (Music) Video" > other uploads.
  - **Penalties:** live, cover, remix, sped up, slowed, karaoke, acoustic, instrumental,
    8D, reaction, tutorial, lesson. A penalty applies only when the term is absent
    from the UG song name.
  - **Match:** token-set similarity of artist and title against title and
    channel.
  - **Duration:** an outlier against the candidates' median (more than 25 % off)
    is penalised.
  - **Hooktheory:** a `human-synced` source is a strong bonus.
  - Duplicates across sources merge.

**Server:**

- The `SongVideos.Source` contribution: `{ id, find(query, exec) → SourceAnswer }`.
- `findSongVideos(query, exec)` fans out to every source, merges, ranks, then
  drops non-embeddable candidates via `checkEmbeddable`.

**Embeddability:**

- Lift `checkOembed` and its status mapping out of `apps/chord/video-availability`
  into `integrations/youtube` (new `server/` and the core mapping).
- Chord keeps its ledger and imports it from there. This is a pure move with no
  table change.

### Sources

- **`song-videos/plugins/youtube-search`.**
  - A new `youtube_audio/search.py` entry in the existing `youtube-audio` uv
    project: `ytsearch10:"{artist} {title}"` with `extract_flat`, returning id,
    title, channel and duration.
  - Shared helpers move to `youtube_audio/_common.py`.
  - The TS side is `searchYouTube(query, exec)` via `runPython`.
- **`apps/chord/song-index` contributes `hooktheory`.**
  - A slug lookup on `chord_sections`, grouped by `videoId`, skipping videos
    chord already knows as gone or not embeddable.
  - It needs a new `(artist_slug, song_slug)` index (a migration through
    `./equin build`).
  - It answers `unavailable` when the index is not loaded. It does not force a
    26k-section load on Sonata's behalf.
  - Chord → integrations is an allowed edge, and Sonata never imports chord.

### The alignment job picks (`ultimate-guitar/plugins/alignment`)

**Row additions:**

- `pick: "auto" | "user"`.
- `candidates: { videoId, title, channel, rank, outcome: "untried"|"aligned"|"weak"|"failed"|"not-embeddable", score|null }[]`.
- `status` gains `resolving` and `needs-video`.
- The UI's `RecordingState` gains the arms *finding a video* and
  *needs a video (n tried)*.

**Triggers:**

- A UG create fires `tabSaved`. With no alignment row yet, the trigger
  inserts `{pick: auto, status: queued}` and enqueues.
- An edit keeps today's behaviour: re-align the chosen video.
- "Find a video" (`POST …/alignment/resolve`) re-runs the pick for an existing
  song.
- **Change video** (the existing `PUT …/video`) sets `pick: user`, and auto never
  overrides it.

**Job flow** (`decideWork` grows a `resolve` arm):

1. `status: resolving`, then `findSongVideos({artist: artistName, title: songName}, exec)`.
   Store the ranked candidates.
2. Take the untried candidates in rank order, at most **3** (each costs a
   download plus a beat analysis, about 30–60 s).
3. For each candidate, `ensureBeatFeatures` + `alignChords`.
   - Score ≥ threshold: **accept**. Set `videoId` and the record, `status: aligned`,
     and stop.
   - Otherwise mark it `weak` or `failed` and continue. A failure is the
     candidate's own only when its audio could not be had
     (`isYouTubeAudioError`: `YouTubeAudioUnavailableError`, or
     `YouTubeAudioDownloadError` — e.g. an HTTP 403); it is `failed` with its
     reason, and the walk goes on. Anything else fails the run.
4. When none passes: `status: needs-video`. The best weak record is kept, and
   played (labelled unconfirmed) while the user is asked.
5. A play-time embed refusal (`POST …/alignment/video-refused {videoId}`) marks
   that candidate `not-embeddable` and re-runs step 2 from the next candidate
   (`pick: auto` only).

**Recording section:**

- The chosen video's title and channel, with "picked automatically" or "set by
  you".
- The score.
- A disclosure listing the tried candidates and their outcome. Clicking one
  switches to it (= Change video).
- "Find a video" when none is set.

## Steps

1. **Score + session:**
   - `meta.recording` and its `mergeScores` / `scaleTempo` rule, with tests;
   - the `TransportDriver` stack in the session, and `registerClock` restoring
     the previous clock;
   - tick, play/seek/loop/tempo through the driver, `syncEpoch`;
   - session tests with a fake driver (loop wrap, stall, external pause, rate
     snapping).
2. **Audio engine.** Driver-anchored rebuild, `scheduler.resync`, drift check,
   sync offset. Scheduler tests for resync.
3. **YouTube web.** `setPlaybackRate`, the media clock (core, tested), cue-seek.
4. **`sonata/recording`.** The `SonataPlayer.Media` slot + panel, the driver
   registration, the mix store and action. `alignedScore` sets `meta.recording`.
5. **Embeddability lift.** `checkOembed` into `integrations/youtube`, with chord
   rewired to it.
6. **`song-videos`.** Core (normalise, rank, with tests), server registry,
   `youtube-search` source (python entry + TS), chord `hooktheory` source + slug
   index.
7. **Alignment.**
   - Row columns and the migration;
   - `decideWork` resolve arm, with tests for the candidate walk, the accept
     threshold, needs-video and user pick sticking;
   - job loop, the create trigger, resolve and video-refused endpoints;
   - Recording section states.
8. **Docs.** Contract notes back into the vision doc (`meta.recording`, the
   driver). Then a backgrounded build, check, and test on the touched plugins.

## Verification

- `./equin test` on sonata session, audio engine, score,
  integrations/youtube (+ song-videos) and ultimate-guitar alignment.
- **Sync, deployed worktree.** Open an aligned song (Let It Be), then
  `screenshot.ts --path <song> --click Play`. By ear:
  - the synth stays on the recording through play, pause, ←/→ seeks, an A-B loop
    over a chorus, and ↑/↓ tempo (the video's rate follows);
  - the mix toggles work;
  - minimising the panel keeps sync, and closing the player falls back to
    synth-only.
- **Pick, 10 songs.** Import 10 UG songs with no video:
  - pop, a key change, a capo song, a sparse acoustic one, a live-famous song,
    and a song with many covers;
  - for each, record the candidates, the chosen video, its score, whether it is
    the right recording (judged against the studio release), and a by-ear note;
  - record which source supplied the winner. Hooktheory in a worktree is a 1/20
    sample, so its hit rate is measured separately against main's index with
    `query_db`;
  - the table goes into this doc. A miss is checked for whether the ranking or
    the threshold failed.

## Known limits (v1)

- **Rate steps.** The tempo snaps to the rates YouTube accepts while a video
  drives.
- **Loop wrap.** It is a seek, not seamless.
- **Count-in.** It is off while a video drives.
- **Hooktheory.** It contributes only where the Chord app's index is loaded.
- **Search.** yt-dlp search is scraping. The YouTube Data API is a later source
  behind the same contribution.

## Results

Run on 2026-10-07 against the worktree deploy `att-1791333308-3vyx`.

### Pick: 10 songs, no video given

Each song was imported through the import dialog's own path: UG search, then
the most-voted "Chords" tab, then fetch, `compile()` and
`POST /api/sonata/songs/ultimate-guitar`. Each create fired `tabSaved`, and the
resolver ran with no other input.

"Right" means the studio recording, judged from the candidate's title and
channel (checked over oEmbed).

| Song (UG tab, capo) | Top 3 candidates (outcome, score) | Chosen | Score | Transpose | Won by | Right recording? |
|---|---|---|---|---|---|---|
| The Beatles – Let It Be (17427, capo 0) | QDYfEBY9NM4 "Let It Be (Remastered 2009)" · The Beatles (aligned 0.70); AbNFLI720_U 2021 Mix (untried); lcA-qlMP11s Naked (untried) | QDYfEBY9NM4 | 0.697 | 0 | search #0 | ✔ (calibrated reference) |
| Oasis – Wonderwall (39144, capo 2) | FVdjZYfDuLE "Wonderwall (Remastered)" · Oasis (aligned 0.87); 6hzrDeceEKc / bx1Bh8ZvH84 Official Video (untried) | FVdjZYfDuLE | 0.872 | 2 | search #0 | ✔ (reference) |
| Adele – Someone Like You (1006751, capo 2) | hLQl3WQQoQ0 Official Music Video (aligned 0.91); 22c3_LoIfZQ "Adele - Topic" (untried); raiQjmyZMC0 lyrics upload (untried) | hLQl3WQQoQ0 | 0.912 | 2 | search #0 | ✔ (reference) |
| a-ha – Take On Me (1842621, capo 2) | -iKeUC5_Wyw "Take on Me (Video Version) [2015 Remaster]" · a-ha (aligned 0.56); NaQ083rNUwc 2016 Remaster (untried); MIgK3zOk0zg album track (untried) | -iKeUC5_Wyw | 0.559 | 2 | search #0 | ✔ studio, but the single/video mix rather than the album track (MIgK3zOk0zg, ranked #3); the score is near the threshold |
| Bon Jovi – Livin' On A Prayer (1185747, capo 0; key change) | lDK9QqIzhwk official video · Bon Jovi (aligned 0.77); 2ognf_oRQWM, CuUefy9bT9U re-uploads (untried) | lDK9QqIzhwk | 0.772 | 0 | search #0 | ✔ |
| Bon Iver – Skinny Love (835053, capo 0; sparse acoustic) | 95FyXUHv8hk "Skinny Love" · Bon Iver - Topic (**weak 0.486**); 5l8otWSs3Ro "Glastonbury 28-06-09" · fan channel (aligned 0.68); ssdgFoHLwnk (untried) | 5l8otWSs3Ro | 0.676 | 0 | search #1 | ✘ live bootleg |
| Eagles – Hotel California (46190, capo 2; famous live) | dLl4PZtxia8 Official Audio · Eagles (aligned 0.91); 1tH7HnGxcNc lyric-translation upload (untried); 09839DpTctU Live 1977 (untried) | dLl4PZtxia8 | 0.909 | 2 | search #0 | ✔ studio, not the live version |
| Leonard Cohen – Hallelujah (64977, capo 5; heavily covered) | ttEMYvpoR-k Official Audio · Leonard Cohen (aligned 0.88); z1rB_XvrM5Q 1984 re-upload (untried); gRsnjNt_Rhw lyrics (untried) | ttEMYvpoR-k | 0.876 | 5 | search #0 | ✔ Cohen's original, not a cover |
| Ed Sheeran – Shape Of You (1928431, capo 0) | JGwWNGJdvx8 Official Music Video (**weak 0.446**); _dK2tDK9grQ Official Lyric Video (**weak 0.425**); liTfD88dbCo 7clouds lyrics (yt-dlp **HTTP 403**) | none (`failed`) | — | — | — | ✘ nothing chosen, although the right video was #1 |
| Vance Joy – Riptide (1237247, capo 1) | uJ_1HMAGb4k Official Video · Mushroom (aligned 0.94); TL_oroU9eN8 "Vance Joy" art track (untried); HXSIxi-VUBM lyrics (untried) | uJ_1HMAGb4k | 0.936 | 1 | Hooktheory + search #0 (merged) | ✔ |

**Summary.**

- **Hit count: 8 of 10 on the right recording.** Take On Me counts as right,
  as the video mix of the studio recording.
- **Misses:** Skinny Love chose a live bootleg, and Shape Of You chose nothing.
- **Transpose:** wherever an alignment was accepted, the transpose equals the
  sheet's capo.
- **Ranking:** it put the studio recording first in all 10 songs.

**Which source won:**

- YouTube search #0 for 8 songs.
- Search #1 for Skinny Love (the live bootleg).
- Hooktheory merged with search #0 for Riptide, the only song in the
  worktree's 1/20 Hooktheory sample.

**Why the two misses happened:**

- **Skinny Love.** The threshold failed, not the ranking. The studio art track
  scored 0.486, just under 0.5. The resolver then accepted the next candidate
  that passed, a live bootleg at 0.676. The accept rule does not prefer a
  slightly weak studio match over a strong match on a version-penalised
  candidate.
- **Shape Of You.** The aligner, or the threshold, failed on the right
  recording: two uploads of the studio audio scored about 0.43–0.45. The third
  try then hit a yt-dlp `HTTP Error 403`, and that error failed the whole job
  (`failed`, Retry) instead of failing that one candidate. The design marks a
  candidate `failed` only for `YouTubeAudioUnavailableError`, so a transient
  403 aborts the walk.
- **An untried candidate.** Main's Hooktheory index also lists `jVCxZlpj8dw`
  ("Shape of You · Ed Sheeran - Topic") for this song. The worktree's sample
  does not have it, so it was never a candidate.

**Hooktheory against main's index.** The slug lookup ran on `chord_sections`
in the `singularity` DB.

- **Rows found:** 8 of 10 songs have a video row. Bon Jovi and Bon Iver have
  rows with no video.
- **Right recording:**

  | Song | Hooktheory video | Right recording? |
  |---|---|---|
  | Let It Be | QDYfEBY9NM4 | ✔ |
  | Wonderwall | 6hzrDeceEKc, official video | ✔ |
  | Someone Like You | hLQl3WQQoQ0 | ✔ |
  | Take On Me | djV11Xbc914, official video | ✔ |
  | Hallelujah | ttEMYvpoR-k | ✔ |
  | Shape Of You | _dK2tDK9grQ and jVCxZlpj8dw | ✔ |
  | Riptide | uJ_1HMAGb4k | ✔ |
  | Hotel California | -nmpVYcg23c | oEmbed 404, gone, so it is dropped |

- **Useful hit rate: 7 of 10.**

### Play: video as the transport (2 aligned songs)

`plugins/apps/plugins/sonata/plugins/recording/e2e/video-sync.ts` measures the
drift at every cursor paint:

- A MutationObserver watches the scrubber fill.
- At each paint it reads the IFrame API's `getCurrentTime()`, which is within
  1–2 ms of the `<video>` element's `currentTime`, as measured inside the
  iframe.
- **drift** = `beatToSeconds(alignedScore, beat)` − video time.

A headless browser animates this page at only about 5 frames per second. So
polling the cursor instead would mostly measure the frame period. That gave a
spurious sawtooth: a −95 ms median and a −200 ms max.

| | Someone Like You (hLQl3WQQoQ0) | Let It Be (QDYfEBY9NM4) |
|---|---|---|
| Play, 20 s (median / p95 / max \|drift\|) | 1 / 4 / 26 ms | 1 / 4 / 10 ms |
| After ← and → while playing (1 s settle) | 1 / 5 / 16 ms | 1 / 9 / 16 ms |
| After an A–B loop wrap (1 s settle) | 1 / 5 / 5 ms | 1 / 12 / 12 ms |
| At ↑↑ = rate 1.5 | 5 / 11 / 13 ms | 3 / 23 / 31 ms |
| Video rate after ↑ ↑ ↓ ↓ | 1.25, 1.5, 1.25, 1 | 1.25, 1.5, 1.25, 1 |
| → while paused: cursor − video | 0 ms, video stays paused | 0 ms, video stays paused |
| Pause: cursor − video | −236 ms | −250 ms |
| Stops / stalls while playing | 0 | 0 |

**What the numbers show:**

- **Playing.** The cursor follows the video to within a few milliseconds:
  while playing, after seeks, across a loop wrap and at 1.5×.
- **Tempo.** ↑ and ↓ move the video's rate in YouTube's steps.
- **Pause.** The cursor freezes at its last painted frame. At about 5 fps
  that frame is about 200 ms old. At 60 fps it would be about 16 ms old.
- **Resume after pause.** Resuming re-seeks the video by that gap, because it
  exceeds the 50 ms `DRIVER_ALIGN_TOLERANCE_SEC`.

**What was not verified:**

- **The synth.** It cannot be judged by ear from here, so no claim is made
  about the synth against the recording. Only the cursor (the driver
  position) was measured. The synth's ±40 ms resync against that same
  position is unit-tested, not measured.
- **The sync offset.** Its default stays 0 until someone listens.

Screenshots: `/tmp/video-sync-letitbe-{1-before-play,2-playing,3-loop,4-mix}.png`.

### Bugs found

- **Fixed: opening an aligned song crashed the player.** The session calls
  `driver.setRate(1)` when the driver registers. A cued video that has never
  played answers `getAvailablePlaybackRates()` with `undefined`, so
  `snapPlaybackRate` threw from a layout effect.
  - **Where:** `integrations/youtube/web/internal/controller.ts`, `iframe-api.ts`.
  - **Fix:** asking for the rate the video already plays at resolves at once.
    Any other request made before the rate list exists is held, then snapped
    and sent when the video first reaches PLAYING. Its promise resolves on
    `onPlaybackRateChange` as before.
  - **Checked:** `video-sync.ts` presses ↑ before the first play, and the
    video then plays at 1.25.
- **Fixed: the first seek after load got YouTube error 2, read as `gone`.**
  - The driver registers as soon as the controller is "ready", before the
    iframe has reported the cue.
  - So `getPlayerState()` was not CUED or UNSTARTED. The controller sent
    `seekTo`, and YouTube answered error 2.
  - `statusFromPlayerCode(2)` is `gone`. The refusal seam then reported
    `video-refused`, which marked the candidate failed and re-picked.
  - Before the fix, every open of an aligned song walked its candidates away.
    That is how Wonderwall lost FVdjZYfDuLE once: three candidates were marked
    failed, then a 403 hit. It was restored with "Find a video".
  - **Where:** `controller.ts` `seekPlayer`.
  - **Fix:** "not started" is now the controller's own record (no PLAYING since
    the load), not `getPlayerState()`.

### Open issues

- ~~**Error 2 counts as a refusal.**~~ Fixed in review (below).
- **A first play right after a cold load is sometimes undone.**
  - In about 2 of 5 headless runs, Space within about 2 s of the video panel
    appearing sent `playVideo`. About 0.3 s later the session sent
    `pauseVideo`, although the iframe had reported only −1 then 3 (buffering),
    never a pause.
  - With a 15 s settle, 5 of 5 runs played.
  - **Suspected cause:** the session stopping on a content change during load,
    for example the alignment-sync write or a song setting settling.
  - Not diagnosed further.
- **Accept rule.** A version-penalised candidate (live) is accepted over a
  studio candidate that scored just under the threshold (Skinny Love). Either
  compare the tried candidates' rank-adjusted scores, or let a strong live
  match fall through to needs-video.
- ~~**A transient yt-dlp 403 aborts the resolver walk.**~~ Fixed in review
  (below).
- **Shape Of You's studio audio aligns at only 0.43–0.45.** This is worth a
  calibration look: a 4-chord loop sheet, so coverage is low.

### Review fixes (2026-10-07)

After the user's review of the deployed app:

1. **The video lives in the Recording section.** `SonataPlayer.Media`, its
   column wrapper in `library/web/panes.tsx`, the minimise state and the `mix`
   header action are gone (and their `config/apps/sonata/**` overrides). The
   recording plugin exports `RecordingVideo({ videoId })`: video, volume
   slider (+ on/off) below it, sync offset below that. The engine's plain
   volume control is back as the synth's level. The Recording section (area
   `editor`, which the player's side column renders first) is seeded open for
   a song that plays on a video.
   - **Collapse mid-play** first STOPPED the transport: the dying player's
     teardown reached the session as a `paused` report before the session had
     dropped the unregistered driver's subscription. Fixed twice over: the
     session ignores reports from a driver no longer in its stack, and the
     video driver says nothing once its player is detached. Session test
     added.
2. **One candidate's download failure no longer ends the pick.**
   `youtube_audio.fetch` exits 4 (`DOWNLOAD_FAILED`) for a yt-dlp download
   error of the video (an HTTP 403 on its stream), thrown as the typed
   `YouTubeAudioDownloadError`; a bot check or a dead network stays a crash
   (the machine's failure). `walkCandidates` marks a candidate `failed` with
   its reason (`candidates[].error`) only for `isYouTubeAudioError`, and
   rethrows anything else. Unit-tested in `decide.test.ts`.
3. **YouTube error 2 is no refusal.** `statusFromPlayerCode` decides only 100
   (`gone`) and 101 / 150 (`not-embeddable`); 2 and 5 are `undecided`. Chord's
   ledger then records the code with a null status (oEmbed's verdict stands).
   The Recording section shows a non-refusal error and does not report it.
4. **A weak match plays.** `isApplicable` became `fitsSheet` (aligner version
   + sheet hash, no score); `appliedAlignment` applies the row's record for
   its video — or, with no video chosen (`needs-video`), the resolver's best
   try — whatever its score. The section labels it "Weak match (45%) —
   playing it, but the timing is unconfirmed" / "Needs a video — playing the
   best try …". The pick's acceptance threshold is unchanged. A refusal that
   re-picks now also clears the refused video's record.

**Verified on the deploy** (`att-1791333308-3vyx`):

- `video-sync.ts` on Let It Be (now opening the Recording section, checking
  its volume and offset sliders, and collapsing it mid-play): 26 / 26 checks
  on the final run — play |drift| median 1 / p95 6 / max 125 ms; after ←/→
  1 / 16 / 23 ms; after a loop wrap 1 / 6 / 8 ms; at rate 1.5 1 / 12 / 14 ms;
  rates 1.25, 1.5, 1.25, 1; collapsed mid-play the transport plays on and
  Space still pauses. An earlier run failed once on "→ while paused jumps the
  cursor" (the cursor moved 0.2 s, as if the key was lost); it passed on the
  other two runs.
- Shape Of You, "Find a video": the walk tried JGwWNGJdvx8 (0.446),
  _dK2tDK9grQ (0.425) and liTfD88dbCo (0.418) → `needs-video`, and the song
  plays the best try's video synced, labelled unconfirmed. liTfD88dbCo
  downloaded fine this time (no 403), so the "walk continues past a failing
  download" path is covered by the unit test only, not observed live.

Screenshots: `/tmp/video-sync-letitbe-4-recording-section.png` (the section:
video, volume, offset), `/tmp/shape-of-you-needs-video-after.png` (a
needs-video song playing its best weak try).

**Known limits added:** the video unmounts with its section (collapsed, or the
side pane folded to its rail) — playback then falls back to the synth on its
own clock; a "not synced" video (chosen, no alignment yet) was not exercised
on the deploy, as no song in the worktree is in that state.
