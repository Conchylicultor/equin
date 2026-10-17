# alignment

Aligns an Ultimate Guitar sheet's chord sequence to a YouTube recording's beats,
stores the result per song, and has the UG source compile its `Score` from it,
so a UG song plays on the recording's real beats instead of the synthesized
4/4. Plans: `research/2026-10-01-apps-sonata-ug-alignment-aligner.md` (the
aligner), `research/2026-10-07-apps-sonata-ug-alignment-video.md` (choosing the
video automatically), `research/2026-10-07-apps-sonata-ug-alignment-scoring.md`
(the scoring and accept rule, calibrated on an 11-sheet set).

## Import graph

The R6 cycle check works at the plugin level, so the edges are drawn to keep it
a DAG:

```
UG web ──▶ alignment core ──▶ tab core ◀── UG (web, server, shared)
alignment server ──▶ UG server (songUltimateGuitar, ugTabSaved)
alignment web ──▶ tab core (UG_SOURCE_ID)  — never UG itself
```

The UG tab model (`UgTab`, the parser, `UG_SOURCE_ID`) is a leaf of its own
(`ultimate-guitar/plugins/tab`), because UG web imports this plugin's core to
compile, and this core reads the tab model. UG's own `core` keeps only the fetch
side. `UgSourceRawSchema` (`{ tab, alignment }`) lives in this core for the same
reason: it names the alignment record.

## Data flow

1. **Video.** Two owners, `pick`:
   - `auto` (the resolver): a new UG song (its first `tabSaved`, no row yet)
     gets `{ pick: auto, status: queued }`; "Find a video" (`POST …/resolve`)
     resets a song to that, candidates and record cleared.
   - `user`: the link field (or a click on a candidate) `PUT`s
     `…/alignment/video { url }` — parsed with `youtubeVideoId` (400
     otherwise), upserted as `videoId, pick: user, status: queued`. Nothing
     automatic replaces a user's pick; a resolver run in progress stops at its
     next step. Rows from before `pick` existed are `user` (DB default).
2. **Job** `sonata.ug-alignment.align` (`server/internal/job.ts`, supervised,
   `run` body, `lock` = songId). It reads both rows and decides what to do with
   `decideWork` (`server/internal/decide.ts`, pure, tested): `idle`, `align`
   (the chosen video) or `resolve` (no video and `pick: auto`).
   - **Resolve.** `status: resolving`; with no candidates yet,
     `findSongVideos({ artist, title }, exec)` (`integrations/youtube/song-videos`:
     Hooktheory + YouTube search, embeddable only, ranked) and the ranked list is
     stored in `candidates`. Then `walkCandidates` (pure, tested) tries the
     untried ones in rank order, at most `MAX_TRIES_PER_RUN` (3): features +
     `alignChords` each. After each try `chooseCandidate`
     (`core/internal/accept.ts`, pure, tested) decides: once a try reaches
     `WEAK_MATCH_THRESHOLD`, the highest-ranked try within `RANK_MARGIN` of
     the best becomes `videoId` (`aligned`) — a studio recording that just
     missed is not passed over for a live take that just passed. A try below
     the threshold is `weak`. A try that throws is the
     candidate's failure only when its audio could not be had
     (`candidateFailure`: audio-fetch's typed `isYouTubeAudioError` —
     unavailable, or a download that failed, e.g. an HTTP 403): that candidate
     is `failed` with the reason in its `error`, and the walk goes on. Any
     other throw (a dependency that will not install, no network, a bot check,
     a DB error) fails the run, retryable. None passing: `needs-video`, the
     best weak record kept — and played (see Player).
     A sheet edit re-tries the same candidates (`retryScored`). A new
     `ALIGNER_VERSION` re-picks a video the resolver chose: `decideWork`
     returns the resolve arm with `release` (the chosen video is cleared
     first) and `retry`, so the tried candidates — their features cached —
     are scored again and the accept rule runs anew. A user's video is only
     re-aligned. "Retry" (`POST …/realign`) on a row with no video and
     `pick: auto` sets it `queued` with its candidates kept, so the walk
     resumes from the next untried one (after a failure, a Cancel or a
     needs-video). An embed refusal
     — `ReportVideoRefused`, contributed to `SonataRecording.Refused`, posts
     `…/video-refused { videoId, status }` — marks the candidate
     `not-embeddable` (or `failed` when gone) and, for the resolver's own pick,
     queues the walk from the next candidate. Idempotent: the panel re-reports
     on every remount.
   - **Align.** Nothing happens with no video, a permanent failure, a Cancel,
     or a record that already matches the current video, sheet and aligner.
     Otherwise the job sets `running` and aligns (`alignTo`, shared with the
     walk's tries). It writes `aligned`
     or `weak` (score vs `WEAK_MATCH_THRESHOLD`) with the record. A result is
     dropped if the video changed while the job ran. A throw writes `failed` and
     rethrows. Only a `NonRetryableError` (the video is unavailable) is
     permanent: `decideWork` never retries a permanent failure, not even after a
     sheet edit, so any other failure (a sheet that does not parse included)
     stays retryable.
   - **Phase.** The job writes the row's `phase` live, each stage awaited
     before the work goes on: `searching` around `findSongVideos`; per video
     (a walk's try or the align arm) null until its first stage, then
     `ensureBeatFeatures`'s `onPhase` stages (`waiting` for another process
     analysing the same video → `fetching` → `installing` → `analysing`; none
     on a cache hit), then `aligning` around `alignChords`. The Recording
     section shows it with "video n of `MAX_TRIES_PER_RUN`" (core).
3. **Cancel.** `POST …/alignment/cancel` (`cancelUgAlignment`, 409 unless the
   row is `queued`, `resolving` or `running`) writes `cancelled` (phase null, a
   `trying` candidate back to `untried`) FIRST — so a queued run that has not
   started, and the walk's `stillResolving` check, both find nothing to do —
   then stops the run holding the song's lock with the supervised-job
   `cancelSupervisedJobByLock` (a queued row may have no run: `not-running` is
   fine). That run closes as cancelled, not failed: no retry, no dead-letter,
   no report. Its `onEnded` sees `meta.cancelled` and writes `cancelled` again
   over whatever the child wrote before the signal reached it, without the
   "interrupted → failed" branch or a re-enqueue — unless the row is `queued`
   by then (a video set or a Retry after the Cancel, whose enqueue lost the
   claim to the dying run), which it enqueues. `decideWork` treats `cancelled`
   as idle in both arms, whatever changed since (a sheet edit, a new aligner):
   only Retry (`realign`), a new video or "Find a video" restarts it.
4. **Re-check.** `onEnded` runs after the run's lock is released. After a clean
   exit, it re-runs `decideWork` and enqueues again when the sheet or the video
   moved during the run, since an enqueue that lost the claim to the running
   job did nothing. After a kill (not a Cancel), it turns a `running` or `resolving` row left
   behind into `failed`.
5. **Sheet edits.** UG's create and update routes emit `sonata.ug.tabSaved
   {songId}`, but only when `content` changed. A `Trigger` binds it to
   `sonata.ug-alignment.on-tab-saved`. That plain job exists because a
   supervised job takes no event payload. It creates the `auto` row for a song
   with none, and enqueues the align job unless the user's row has no video.
   An edit re-aligns the chosen video; it never re-picks, and never restarts
   a cancelled one. UG knows nothing of
   this plugin.
6. **Player.**
   - Which record goes into `raw.alignment` is one rule, `appliedAlignment`
     (`core/internal/source-raw.ts`): the row's record when it `fitsSheet`
     (same sheet, and every chord segment still names its chord — by the
     `symbol` it stored — in today's parse) and is the row's video's — or, with no
     video chosen, the resolver's best try (`needs-video`) — else `null`. The
     score plays no part: a weak match is applied too, so the video plays and
     drives the transport, and the Recording section labels it unconfirmed
     with its score. `WEAK_MATCH_THRESHOLD` only decides whether the resolver
     keeps looking. Nor does `alignerVersion`: a record an earlier aligner made
     keeps playing (labelled "made by an earlier aligner") until the job next
     runs for the song and re-aligns it, so bumping `ALIGNER_VERSION` never
     silences the alignments already made. A parser change that moves the
     indices is what `fitsSheet` catches instead. The row's `status` plays no part either, so a re-align that
     is queued, running or failed leaves the last alignment of this video and
     sheet playing, and setting a new video drops the old one's at once.
   - UG `hydrate` fetches the tab and the alignment row (`getUgAlignment`)
     together and applies that rule, so an aligned song opens aligned.
   - The `ug-alignment-sync` `Sonata.Effect` (`web/components/alignment-sync.tsx`)
     follows the live row and writes the same rule's result into the raw,
     compared by value, so playback resets at most once per finished job (and
     not at all right after `hydrate`).
   - UG's persist observer saves only when `raw.tab` changes, so this write is
     never taken for an edit.
   - UG `compile()` applies the record only when it `fitsSheet`, and otherwise
     falls back to the synthesized timeline. A record that no longer lands on
     the sheet's chords is rejected by construction.
7. **Status.** The Recording section (`area: "editor"`, gated on a UG raw, no
   header summary) derives a `RecordingState` union from the live row and the
   open tab (`web/internal/recording-state.ts`): loading, no video, working
   (`{ videoId, progress }`), needs a video (n tried, best score), aligned
   (score and signed transpose with capo, "+2 (capo 2)"), weak, failed
   (message, permanence), cancelled and out of date (the record would not play: another sheet or
   video, or its chords moved — and nothing is re-aligning). Aligned and weak
   note a record made by an earlier aligner. Loading is its
   own arm, never rendered as "no video". `alignProgress(row)` (pure) is a
   working row's `{ stage: find | analyse | align, step, candidate }`: `step`
   is the live `phase`, or `queued` / `preparing` between phases; `searching`
   is the find stage, the beat analysis's phases the analyse stage, `aligning`
   the align stage; with no phase, a chosen video or found candidates mean
   finding is done. `candidate` (the walk's `trying` one) carries "video n of
   m": n counts the tried candidates in runs of `MAX_TRIES_PER_RUN` (the row
   does not record a run's start, so a run after one that stopped early can
   be off), m is capped by the untried left.
   The body, top to bottom: `RecordingVideo`; `AlignmentStatus`
   (`web/components/alignment-status.tsx`: icon + status line + one control —
   Cancel while working, Re-align when aligned or out of date, Retry after a
   retryable failure or a cancel, Try another (opens Replace) for a weak match
   or needs-video, Find a video with none, nothing for a permanent failure —
   and while working a three-segment stage bar whose current segment is an
   indeterminate CSS sweep, `stage-progress.css`; no percentage, none is
   reported); the video's `SourceLine` (the chosen video, else the candidate
   being tried, else the one on screen: title, match chip — who picked it in
   its tooltip — channel, Replace / Done); and, while open, `VideoReplace`
   inline below it (`web/components/video-replace.tsx`): the link field
   prefilled with the chosen video's URL and Use, the candidates (thumbnail,
   title / channel, outcome chip; a click sets it, `pick: user`; the current
   one and a non-embeddable one cannot be picked; hover shows an "Open on
   YouTube" link) and Search again (`resolveUgAlignment`). A video with no
   candidate entry is titled "YouTube video <id>".

## Storage

`sonata_songs_ext_ug_alignment` (`defineExtension(_songs, "ug_alignment", …)`,
shape `ugAlignmentShape` in `core/internal/row.ts`) has the columns `videoId |
null`, `status` (`queued | resolving | running | aligned | weak | needs-video |
failed | cancelled`), `phase | null` (`searching | waiting | fetching |
installing | analysing | aligning`), `error | null`,
`errorPermanent`, `pick` (`auto | user`), `candidates` (jsonb: `{ videoId,
title, channel, rank, sources, outcome: untried | trying | aligned | weak |
failed | not-embeddable, score }[]`) and `record | null` (jsonb decoded by
`AlignmentRecordSchema`). `status` and `phase` are text columns decoded by
zod, so a new value takes no migration (keep the old ones parseable). It is
served as the lookup-only
live collection `sonata-ug-alignment` (`shared/resources.ts`), read with
`useLiveRow(ugAlignmentRows, songId)`.

The job's transcript goes to the `sonata-ug-alignment` log channel.

## Tests

- `core/*.test.ts`: the aligner and `alignedScore` on synthetic features
  (`core/testing/synthFeatures`), and `appliedAlignment`.
- `server/internal/decide.test.ts`: `decideWork` (resolve arm, user pick
  sticky, `cancelled` idle in both arms even after a sheet edit), the
  candidate walk (rank order, threshold, at most 3, unavailable,
  interruption) and `untryCandidates`.
- `web/internal/recording-state.test.ts`: the row → `RecordingState` mapping,
  `alignProgress` (stage, step, "video n of m") and the status line.
- Calibration on real cached features: `scripts/calibrate.ts`. `--set` runs
  the calibration set (11 sheets, 17 recordings; tabs cached in the
  `ug-calibration` data dir, fetched once with `--fetch <origin>`): the score
  matrix, the right/wrong separation, per-sheet margins and the accept rule's
  pick per song. `--bars` prints one pair bar by bar (path chord vs the best
  sheet chord and triad).

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: UG sheet alignment in the player: a 'Recording' editor section showing the song's YouTube video (the recording plugin's RecordingVideo viewport with its volume, and its on/off RecordingSwitch in the header; the video itself is declared by a headless effect to the session's recording player, so it keeps playing — synced to the transport when the song plays on its alignment, a weak match included, else on its own — while the section is collapsed), an alignment status box (icon, status line, one control — Cancel, Re-align, Retry, Try another or Find a video — and while working a three-stage bar: find a video, analyse the audio, align the sheet), the video's line (title, match chip, channel, Replace) and an inline picker (a YouTube link, the candidate videos with thumbnail and outcome — click one to switch — and Search again); a headless report of a video the player refuses (SonataRecording.Refused → video-refused), and a headless effect writing the applied alignment record into the Ultimate Guitar raw so the Score plays on the recording's beats. UG sheet alignment server: owns the sonata_songs_ext_ug_alignment side-table (video, who picked it, the resolver's candidates, status, record) served as a lookup-only live collection, the sonata.ug-alignment.align supervised job (choose a video with findSongVideos and walk the best candidates when none was set; beat features → alignChords → record, its live phase written on the row; a user's Cancel stops it as cancelled), the set-video / find-a-video / video-refused / re-align (also resuming a cancelled or failed walk) / cancel / get endpoints, and a trigger that starts choosing a video for a new UG song and re-aligns one whose sheet changes.
- Web:
  - Contributes:
    - `Sonata.Section` "Recording" → `RecordingSection`
    - `Sonata.Effect` "ug-alignment-sync" → `UgAlignmentSync`
    - `Sonata.Effect` "ug-recording-video" → `UgRecordingVideo`
    - `SonataRecording.Refused` "ug-video-refused" → `ReportVideoRefused`
  - Uses: 35 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `apps/sonata/recording` ×5
    - `infra/endpoints` ×3
    - `primitives/css/spacing` ×3
    - `primitives/css/ui-kit` ×3
    - `network/live` ×2
    - `primitives/css/badge` ×2
    - `primitives/css/fill` ×2
    - `primitives/hover-reveal` ×2
    - `apps/sonata/document.useSongDocument`
    - `apps/sonata/primitives/source-line.SourceLine`
    - `apps/sonata/shell.Sonata`
    - `primitives/css/clip.Clip`
    - `primitives/css/grid.Grid`
    - `primitives/css/line.Line`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/spinner.Spinner`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/link-gesture/new-tab.NewTabButton`
    - `primitives/loading.Loading`
    - `ui/icons.Icon`
- Server:
  - Contributes:
    - `resource.declare` "sonata-ug-alignment:rows"
    - `trigger` "sonata.ug-alignment.on-tab-saved"
  - Uses:
    - `apps/sonata/library._songs`
    - `apps/sonata/sources/ultimate-guitar.songUltimateGuitar`
    - `apps/sonata/sources/ultimate-guitar.ugTabSaved`
    - `infra/audio-analysis.ensureBeatFeatures`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `infra/entity-extensions.defineExtension`
    - `infra/events.Trigger`
    - `infra/jobs.defineJob`
    - `infra/jobs.isNonRetryableError`
    - `infra/jobs/supervised-job.cancelSupervisedJobByLock`
    - `infra/jobs/supervised-job.defineSupervisedJob`
    - `integrations/youtube/audio-fetch.isYouTubeAudioError`
    - `integrations/youtube/song-videos.findSongVideos`
    - `network/live.serveCollection`
    - `primitives/log-channels.defineLogSink`
  - DB schema: `plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/alignment/server/internal/tables.ts`
  - Entity extension of: `apps/sonata/library` (table `library_ext_ug_alignment`)
  - Register:
    - `defineSupervisedJob('sonata.ug-alignment.align')`
    - `defineJob('sonata.ug-alignment.on-tab-saved')`
  - Resources: `sonata-ug-alignment:rows` (keyed, point)
  - Routes:
    - `GET /api/sonata/songs/:id/ultimate-guitar/alignment`
    - `PUT /api/sonata/songs/:id/ultimate-guitar/alignment/video`
    - `POST /api/sonata/songs/:id/ultimate-guitar/alignment/realign`
    - `POST /api/sonata/songs/:id/ultimate-guitar/alignment/resolve`
    - `POST /api/sonata/songs/:id/ultimate-guitar/alignment/video-refused`
    - `POST /api/sonata/songs/:id/ultimate-guitar/alignment/cancel`
- Core:
  - Uses:
    - `apps/sonata/sources/ultimate-guitar/tab.InferredSection`
    - `apps/sonata/sources/ultimate-guitar/tab.inferSections`
    - `apps/sonata/sources/ultimate-guitar/tab.ParsedLine`
    - `apps/sonata/sources/ultimate-guitar/tab.ParsedTab`
    - `apps/sonata/sources/ultimate-guitar/tab.parseUgContent`
    - `apps/sonata/sources/ultimate-guitar/tab.UgTabSchema`
    - `apps/sonata/theory.parseChordSymbol`
    - `apps/sonata/theory.parseKeySignature`
    - `apps/sonata/theory.qualityToIntervals`
    - `apps/sonata/theory.transposeKey`
    - `apps/sonata/theory.transposeScore`
    - `fields.nullable`
    - `fields/bool/config.boolField`
    - `fields/json/config.jsonField`
    - `fields/text/config.parsedTextField`
    - `fields/text/config.textField`
    - `infra/endpoints.defineEndpoint`
    - `infra/entity-extensions.defineExtensionShape`
  - Exports (types):
    - `AlignmentCandidate`
    - `AlignmentPhase`
    - `AlignmentSegment`
    - `AlignmentStatus`
    - `CandidateOutcome`
    - `UgAlignmentRow`
    - `UgSourceRaw`
    - `VideoPick`
  - Exports (values):
    - `alignChords`
    - `alignedScore`
    - `ALIGNER_VERSION`
    - `AlignmentPhaseSchema`
    - `AlignmentRecordSchema`
    - `AlignmentSegmentSchema`
    - `AlignmentStatusSchema`
    - `appliedAlignment`
    - `cancelUgAlignment`
    - `fitsSheet`
    - `getUgAlignment`
    - `MAX_TRIES_PER_RUN`
    - `realignUg`
    - `refuseUgAlignmentVideo`
    - `resolveUgAlignment`
    - `setUgAlignmentVideo`
    - `sheetHash`
    - `UgAlignmentRowSchema`
    - `ugAlignmentShape`
    - `UgSourceRawSchema`
    - `WEAK_MATCH_THRESHOLD`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --primary-text`
    - `ui/tokens/color-palette --success`
    - `ui/tokens/color-palette --warning`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
- Test helpers:
  - Core: `@plugins/apps/plugins/sonata/plugins/sources/plugins/ultimate-guitar/plugins/alignment/core/testing`
    - `parsedSheet` — A `ParsedTab` from a terse spelling: one entry per section, each line a space-separated chord row ("C G Am F") placed over an empty lyric, or a `{ lyric }` for a lyric-only line.
    - `synthFeatures` — Synthetic beat features from one chord symbol per beat (`null` = silence: pure noise at low rms; a symbol theory cannot read throws).
    - Types: `SynthFeaturesOptions`

<!-- AUTOGENERATED:END -->
