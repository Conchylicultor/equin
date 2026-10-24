# Chord trainer — video availability

Track page: `block-49ba706c-affe-417b-a9a1-b6873e8c7ea8` ("Chord trainer app").
Builds on the song index:
[v1](2026-09-16-apps-chord-trainer-song-index.md) (§"Video availability" — this
doc replaces it), [v2](2026-09-16-apps-chord-trainer-song-index-v2.md) (fork and
backup rules), [v3](2026-09-17-apps-chord-trainer-song-index-v3.md),
[v4](2026-09-17-apps-chord-trainer-song-index-v4.md) (which left video
availability out of that step, with `findLoopWindows` as the named seam).

## Context

The trainer plays a loop of a real song inside a YouTube embed. The index holds
183,270 loop windows across 25,855 sections, and it will happily offer any of
them. It has no idea which videos still play.

**Measured on 720 distinct video ids from the dump, 2026-09-17/18**, through
`https://www.youtube.com/oembed`:

| oEmbed | Count | Share | What it means | Status |
|---|---|---|---|---|
| 200 | 592 | 82.2 % | The video is there | `ok` |
| 404 `Not Found` | 112 | 15.6 % | Removed or private (the watch page reports `status:"ERROR"`) | `gone` |
| 403 `Forbidden` | 15 | 2.1 % | Sign-in required / age-restricted (watch page `status:"LOGIN_REQUIRED"`); it cannot play in an embed | `not-embeddable` |
| 401 `Unauthorized` | 1 | 0.1 % | The owner disabled embedding | `not-embeddable` |

So **about 1 video in 6 cannot be played**, not the 3 % v1's 60-video sample
suggested. Weighted by sections rather than videos it is the same picture:
83.8 % of sections sit on a playable video, 14.1 % on a gone one, 2.1 % on a
blocked one. Today that is roughly one dead loop in every six the trainer would
offer.

**This answers v1's open question.** It guessed 401 for an embed-disabled video
and said to store anything other than 200/404 as its code without guessing.
Both 401 and 403 are real, reproducible per-video answers — each one repeated
identically on three serial re-checks, so neither is throttling — and both mean
the same thing to an embed. A fifth code turned up too: **400 `Bad Request`**,
for a "video id" that is not one. The dump really contains those: a transcriber
typed the bare word `cheerleader` into Hookpad's YouTube field, and
`youtubeVideoId` accepts it because it is eleven URL-safe characters. Nothing
will ever play there, so it is `gone`.

Two more things the measurement settled:

- **oEmbed is cheap and tolerant.** ~1,000 requests, up to 12 in flight, drew no
  429 and no slow-down; 120 checks took 0.8 s wall. Scraping watch pages, by
  contrast, got this machine a `google.com/sorry` captcha after about a hundred
  pages. So availability is read from oEmbed and **never** from the watch page.
- **oEmbed is not the whole truth.** Of 74 readable oEmbed-`ok` videos, none had
  embedding disabled — the blind spots are elsewhere: region blocks, which are
  invisible from one location, and the label videos that refuse playback on
  other sites. Only the player sees those, which is why its reports have to be
  recorded and have to win.

## Design

### No sweep: the check happens when a loop is offered

v1 planned a background sweep of all ~12.7k videos on a schedule. Dropped. The
trainer only ever needs to know about the videos it is about to hand over, and
`findLoopWindows` already returns a small batch drawn at random from thousands
of matching windows. So the check rides on that call:

1. The SQL asks for a multiple of the requested `limit` and already leaves out
   the videos known to be unplayable.
2. Whatever came back whose video has no fresh answer is checked over oEmbed, in
   one parallel wave, and the answers are stored.
3. The candidates that just came back unplayable are dropped, and up to `limit`
   survivors are returned.

Nothing checks a video nobody will see. There is no backlog, no cron, no burst
of traffic to one third party, and no "main-only schedule" gap (a scheduled job
installs only under `isMain()`, so it would never run on a release —
`plugins/infra/plugins/jobs/server/internal/worker.ts:168`, the known gap
documented at `plugins/stats/plugins/cost/server/internal/refresh-job.ts:25`).

The cost is on the first calls only: a cold batch is ~20 checks at ~80 ms each
in one wave, so roughly 150 ms on top of the 31 ms the query takes today. Once
the videos around the learner's unlocked set are known, it is back to 31 ms. The
wave is bounded (`VIDEO_CHECK_TIMEOUT_MS`, `VIDEO_CHECK_CONCURRENCY`), and a
check that fails or times out **keeps** the candidate: an unreachable YouTube
must never empty the trainer.

### One row per video, one observation per source

**`chord_videos`** — an observation ledger, not a verdict:

| Column | Notes |
|---|---|
| `videoId` text PK | The parsed YouTube id. |
| `oembedStatus` | `ok` \| `gone` \| `not-embeddable`, **nullable** — null is "no answer we could read". |
| `oembedCode` int null | The HTTP code as observed, including the ones that mean nothing to us. |
| `oembedCheckedAt` null | |
| `playerStatus` | Same three values, nullable. |
| `playerCode` int null | The IFrame API error code. |
| `playerCheckedAt` null | |

Each source writes only its own three columns, so **one source can never
overwrite the other's evidence** — there is no spelling for it. `unknown` is not
a stored value: it is the absence of both.

### The verdict is a derived view, not a column

**`chord_video_status_v`** (`server/internal/views.ts`, a `View({ view })`
contribution — a plain derived view, so changing the rule generates no
migration; `plugins/database/plugins/derived-views/CLAUDE.md`) exposes
`(videoId, status)` where an observation older than `EVIDENCE_TTL_DAYS` (90)
counts as no observation, and:

```sql
CASE
  WHEN fresh_oembed = 'gone'      THEN 'gone'            -- a 404 is decisive
  WHEN fresh_player IS NOT NULL   THEN fresh_player      -- the player saw the real thing
  WHEN fresh_oembed IS NOT NULL   THEN fresh_oembed
  ELSE 'unknown'
END
```

Three lines, each earned by what its source can actually observe. The player
wins, because oEmbed is blind to region blocks and to sites that refuse
playback — so a fresh oEmbed `ok` must not resurrect a video the player just
failed on. The one exception is a 404: the video is gone whoever played it last
month. Ageing an observation out is what makes a re-check happen at all, lazily,
the next time that video is offered.

The status column is `parsed(VideoStatusSchema, sql\`CASE …\`)`
(`@plugins/database/plugins/sql-projection/server`) — decoded, never asserted.

Rejected: a stored `status` column written by both writers (the rule then lives
in two write paths and each can clobber), and a Postgres generated column (same
guarantee, but it re-enters the migration chain for a rule that is code).

### The player's reports

`POST /api/chord/videos/:videoId/playback`, body a discriminated union:

- `{ outcome: "playing" }` → `playerStatus = ok`.
- `{ outcome: "error", code }` → `100` and `2` → `gone`; `101` and `150` →
  `not-embeddable`; anything else (`5`, an HTML5 player fault) records the code
  with `playerStatus` left null, because it says nothing about availability.

Nothing calls it yet — the player belongs to the training-loop step. It is
built now so that step has one call to make, and an e2e script exercises it.

### What the loop query changes to

`plugins/apps/plugins/chord/plugins/song-index/server/internal/find.ts`:

- `findLoopWindows` gains `.leftJoin(chordVideoStatus, eq(…videoId, s.videoId))`
  and `WHERE (v.status IS NULL OR v.status NOT IN ('gone','not-embeddable'))`.
  **Left join, fail open:** a video nobody has looked at is offered, which is
  exactly the point — the on-demand check settles it a moment later.
- It selects `videoStatus` into each `LoopCandidate`, so the caller can tell
  "checked and fine" from "nobody has looked yet".
- It fetches `limit * CANDIDATE_OVERFETCH` (3) rows, runs the check wave over
  them, drops the newly-unplayable, and returns up to `limit`. Returning fewer
  than `limit` is legal — `limit` has always meant "at most".

**`countLoopsByNextChord` is deliberately left alone.** It answers "which chord
should I unlock next", scans the windows with no join to sections at all, and
costs 87–119 ms as a result. Filtering it would make it agree with what `find`
returns, but its number is used to *rank* chords, the ~17 % loss falls roughly
evenly across them, and with on-demand checking most videos are `unknown`
anyway, so the filter would remove almost nothing for a join over 183k windows.
If that count ever becomes something the user reads as a promise ("unlock vi for
1,542 songs"), it needs the join **and** a swept corpus; both are one change and
neither is this step.

### Forks, backups, change feed

As v2 decided. `chord_videos` is **kept** in worktree forks and in backups: it
is ~13k tiny rows, it holds the player's reports, which nothing can recover, and
copying it spares every worktree the re-checking. It is excluded from the change
feed — no live surface reads it — with the reason recorded, to be removed if one
ever does.

No growth bound is declared: the table grows only with videos the index actually
offered, which the dump bounds at ~12.7k, and the retention monitor's silencing
set must only ever hold bounds that are real.

## Layout

```
plugins/apps/plugins/chord/plugins/video-availability/
  package.json, CLAUDE.md
  core/  status.ts        VideoStatus + schema, statusFromOembedCode,
                          statusFromPlayerCode (both returning a decided /
                          undecided result, never null), EVIDENCE_TTL_DAYS
         endpoints.ts     the playback report + a status-summary read
         index.ts
  server/ internal/tables.ts     chord_videos
          internal/views.ts      chord_video_status_v
          internal/check.ts      ensureVideoStatus(ids) — the oEmbed wave
          internal/oembed.ts     one fetch, one mapping, bounded
          internal/report.ts     recordPlayerReport
          internal/handlers.ts
          index.ts               barrel: _chordVideos, chordVideoStatus,
                                 ensureVideoStatus, the routes, contributions
```

`song-index` imports `video-availability`'s server barrel; nothing imports back,
so the graph stays a DAG. The load path is untouched — rows are minted by the
check, so there is no registration step and no coupling to `loadSections`.

Plain `fetch` against the fixed `youtube.com` host, not `safeFetch`, with the
same comment `plugins/integrations/plugins/hooktheory/server/internal/request.ts:28`
carries, so nobody "fixes" it later: safe-fetch guards URLs a *user* supplied.

Concurrent `find` calls asking about the same video collapse onto one request
through `createInflight` (`@plugins/packages/inflight`).

## Implementation steps

1. `core/status.ts` + unit tests: the five oEmbed codes above and the IFrame
   codes, each mapping asserted, and an unknown code coming back `undecided`.
2. `server/internal/tables.ts`, `views.ts`, and the barrel's contributions
   (`View`, `ExcludeFromChangeFeed`).
3. `oembed.ts` + `check.ts`: the bounded wave, the upsert, fail-open on error.
4. `report.ts` + the two endpoints.
5. `find.ts`: the join, the over-fetch, the wave, `videoStatus` on the
   candidate; update `LoopCandidateSchema` in `song-index/core/endpoints.ts`.
6. `CLAUDE.md` for the new plugin (the code table, the resolution rule and why
   the player wins, why there is no sweep), and the two lines this changes in
   `song-index/CLAUDE.md`. Track-page card.

## Verification

1. `./equin test plugins/apps/plugins/chord` — the mapping tests, and a
   `worktree-db` test driving the view's truth table: each source alone, the two
   in conflict both ways, and an observation aged past the TTL.
2. `./equin build` (background): migrations, boundaries, type-check, docs.
3. `ensure` the index on this worktree (sample scope), then `POST
   /api/chord/loops/find`: the first call takes ~150 ms longer than the second,
   `query_db` shows `chord_videos` rows appearing only for the videos that call
   touched, and every returned candidate's video is `ok` or `unknown`.
4. `query_db` on `chord_video_status_v` after a few calls: roughly 5 in 6 `ok`,
   matching the sampled rate.
5. POST a fake player error 150 for a video a `find` just returned, then re-run
   the same `find`: that section is gone from the results, and the view says
   `not-embeddable` while `oembedStatus` still reads `ok` — the evidence is not
   lost, it is outranked.
6. Re-measure `find`'s p95 over 100 random unlocked sets, warm, and record it
   next to the 31 ms already in `song-index/CLAUDE.md`.
7. `e2e/video-availability-verify.ts` drives 3–5 against the deploy.

## Left open

- **Nobody calls the playback endpoint until the training loop exists**, so
  until then the only evidence is oEmbed's, and region-blocked videos stay
  invisible. That is the step where this closes.
- **No global picture of the corpus.** Without a sweep, the share of dead videos
  is known only from the sample in this doc. If it is ever wanted as a live
  number — for the next-chord count, or to prune the index — it is a one-off
  script over the same oEmbed call, not a standing job.
