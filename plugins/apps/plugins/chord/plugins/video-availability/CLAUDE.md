# video-availability

Whether a song's YouTube video still plays in the trainer's embed. About 1
video in 6 in the Sheet Sage dump no longer does, so a loop query that ignored
it would offer a dead loop every sixth time. Design:
`research/2026-09-18-apps-chord-video-availability.md`.

## Using it

```ts
// Server, from the loop query: the status of each video it is about to offer,
// checking over oEmbed the ones nobody has a fresh answer for. Fails open.
ensureVideoStatus(videoIds) → ReadonlyMap<videoId, VideoStatus>

// Filter in SQL: left-join the verdict view, keep a missing row (never checked).
.leftJoin(chordVideoStatus, eq(chordVideoStatus.videoId, …))
.where(or(isNull(chordVideoStatus.status), notInArray(chordVideoStatus.status, [...UNPLAYABLE_STATUSES])))

// The player, once it has tried a video. Answers the status after the report.
POST /api/chord/videos/:videoId/playback  { outcome: "playing" } | { outcome: "error", code }
  → { status: VideoStatus }

// How the videos looked at so far resolve (not the whole index: nothing sweeps).
GET /api/chord/videos/summary → { videos, byStatus: { unknown, ok, gone, not-embeddable } }
```

`VideoStatus` is `unknown` | `ok` | `gone` | `not-embeddable`;
`UNPLAYABLE_STATUSES` is the last two. The trainer's player (`trainer/web`)
calls the playback endpoint: `playing` the first time a video plays in a
visit, and every player error with its code (after which the trainer moves to
the next loop).

## Two sources, one row per video

`chord_videos` is an observation ledger, not a verdict. oEmbed and the player
each own three columns (status, code, checked-at) and write only those, so one
source can never overwrite the other's evidence. A null status is "no answer we
could read"; the code is kept either way. `unknown` is never stored.

The request and the code mappings are not this plugin's: `checkOembed`
(`integrations/youtube/server`) asks oEmbed, and `statusFromOembedCode` /
`statusFromPlayerCode` / `EmbedStatus` (`integrations/youtube/core`) say what a
code means, so anything else that needs "does this video play in an embed?"
(Sonata's video resolution) asks the same way. This plugin keeps the ledger,
the view and the trainer's policy.

**oEmbed** (`https://www.youtube.com/oembed`), measured on 720 video ids from
the dump, 2026-09-17/18:

| Code | Share | What it means | Status |
|---|---|---|---|
| 200 | 82.2 % | The video is there | `ok` |
| 404 | 15.6 % | Removed or private | `gone` |
| 400 | (rare) | Not a video id at all — a transcriber typed `cheerleader`, which passes as eleven URL-safe characters | `gone` |
| 403 | 2.1 % | Sign-in required / age-restricted: cannot play in an embed | `not-embeddable` |
| 401 | 0.1 % | The owner disabled embedding | `not-embeddable` |
| anything else | — | Throttling, a server fault: says nothing | null (code kept) |

Each 401 and 403 repeated identically on three serial re-checks, so neither is
throttling. oEmbed is cheap and tolerant (~1,000 requests, 12 in flight, no
429). The watch page is never read: scraping it got the machine a
`google.com/sorry` captcha after about a hundred pages.

**The player** (IFrame API `onError`): 100 → `gone`; 101 and 150 →
`not-embeddable`; `playing` → `ok`; any other code is kept with a null status —
2 (an invalid parameter: the caller's bug, not the video's) and 5 (an HTML5
fault) say nothing about the video, so the verdict stays oEmbed's. The columns hold the player's last report.

## The verdict: `chord_video_status_v`

A derived view (rebuilt on every boot, no migration). Evidence older than
`EVIDENCE_TTL_DAYS` (90) counts as none. Then:

1. oEmbed says `gone` → `gone`. A removed video is gone whoever played it last
   month.
2. Else the player's answer, when it has one. **The player wins** because
   oEmbed is blind to region blocks and to label videos that refuse playback on
   other sites — of 74 readable oEmbed-`ok` videos none had embedding disabled,
   so the blind spots are exactly what only a player sees. A fresh oEmbed `ok`
   must not resurrect a video the player just failed on.
3. Else oEmbed's answer, else `unknown`.

The status column is decoded through `VideoStatusSchema`, never asserted. The
rule lives only here: `ensureVideoStatus` re-reads the view after its checks
rather than re-deriving the answer.

## No sweep

A video is checked when a loop query is about to offer it and it resolves
`unknown` — never checked, answered with a code that says nothing, or aged past
the TTL. So nothing checks a video nobody will see, there is no backlog and no
burst of traffic to YouTube, and a re-check happens lazily, the next time the
video is offered. (A scheduled sweep would also run only on main:
scheduled jobs install only under `isMain()`, so it would never run on a
release.)

The wave: at most 8 requests in flight across the backend, each bounded to 2 s,
and two queries asking about the same video share one request. A cold batch
costs ~150 ms once. **It fails open**: a request that errors or times out
records nothing and leaves the video `unknown`, and the loop query offers it —
an unreachable YouTube must never empty the trainer. Each such check, and each
code that says nothing, is written to the `chord-video-check` log channel. A
failing database write is not covered: it throws.

## Forks, backups, change feed

`chord_videos` is **kept** in worktree forks and backups: ~13k tiny rows at
most, it holds the player's reports, which nothing can recover, and copying it
spares every worktree the re-checks. It is **excluded from the change feed**: no
live surface reads it (the loop query reads it per call). Remove that exclusion
if one ever does.

No growth bound is declared: rows are minted only for videos a loop query
offered (plus player reports, which are id-validated), which the dump bounds at
~12.7k, and the retention monitor's silencing set must only hold bounds that
are real.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Chord video availability: the chord_videos evidence ledger (oEmbed's answer and the player's, each in its own columns), the chord_video_status_v view that resolves them, the on-demand oEmbed check a loop query runs over the videos it is about to offer, and the player's playback-report endpoint.
- Server:
  - Contributes:
    - `derived-view` "chord_video_status_v"
    - `change-feed-exclusion` "chord_videos"
  - Uses:
    - `database.db`
    - `database/change-feed.ExcludeFromChangeFeed`
    - `database/derived-views.View`
    - `database/sql-column.parsedText`
    - `database/sql-projection.parsed`
    - `infra/endpoints.HttpError`
    - `infra/endpoints.implement`
    - `integrations/youtube.checkOembed`
    - `primitives/log-channels.defineLogSink`
  - DB schema:
    - `plugins/apps/plugins/chord/plugins/video-availability/server/internal/tables.ts`
    - `plugins/apps/plugins/chord/plugins/video-availability/server/internal/views.ts`
  - Exports (values):
    - `_chordVideos`
    - `chordVideoStatus`
    - `ensureVideoStatus`
  - Routes:
    - `POST /api/chord/videos/:videoId/playback`
    - `GET /api/chord/videos/summary`
- Core:
  - Uses:
    - `infra/endpoints.defineEndpoint`
    - `integrations/youtube.EmbedStatusSchema`
  - Exports (types):
    - `PlaybackReport`
    - `VideoStatus`
    - `VideoStatusCounts`
  - Exports (values):
    - `EVIDENCE_TTL_DAYS`
    - `PlaybackReportSchema`
    - `reportPlaybackEndpoint`
    - `UNPLAYABLE_STATUSES`
    - `VideoStatusCountsSchema`
    - `VideoStatusSchema`
    - `videoStatusSummaryEndpoint`
- Cross-plugin:
  - Imported by: `apps/chord/song-index`

<!-- AUTOGENERATED:END -->
