# promo-film

**Reporting to the user: every file is written as its full path**
(`~/Downloads/showcase/equin-v0.mp4` or the absolute path, never a bare name or
a path relative to a folder named elsewhere) — the films, music candidates and
previews, stills, logs — so each one is clickable.

## Where the film is recorded

On this checkout's **`promo-film` composition**, never on main: the whole app
on its own empty database, holding the curated story of `plugins/seed`.

```bash
./equin build --composition promo-film   # http://promo-film.<checkout>.localhost:9000
./equin promo-film seed                  # reset it to first launch, write the story
```

A recorder or capture script targets it with the e2e harness's
`--composition promo-film` (no hand-written URL). See `plugins/seed/CLAUDE.md`.

It is also the only composition that ships the film's own plugins, Circle
(`plugins/circle`) and the seed: every other row inherits the default
exclusion set, `all-exclusions`, which leaves both out, while `promo-film`
names the narrower `base-exclusions` (its `exclusions` field). So main never
bundles them; `./equin promo-film seed` (this plugin's `cli/`) works from any
checkout, and needs the promo-film build.

## Recording and rendering

```bash
./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/record.ts --composition promo-film [--only pages,sonata,…]
./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/film.ts [--preview] [--captions] [--stills t1,t2]
```

- **The script is the Video page's Script v2 page (its Principles first, then
  Script v4); its code is `e2e/internal/segments.ts`** — one recorded segment
  per scene, each a few minutes to re-record (`pages`: Home → Pages → Buying a
  piano (context + the user's checklist of shops) → the shops Wish, the agent
  completing the list live in ONE `edit_page` (the seed's
  `POST /api/promo-film/agent-shops`: every shop, a blank line, a map — one
  push), the camera following it as the approved prototype
  `proto-1794145785-ej5bjg` does (`PAGES_CAMERA`: `single` or `staged`) →
  the map's expand → Places grows out of the map → a shop's detail → its
  photos → back → the opening-times Wish with Pick UI on a whole card
  (time-lapse) → the launcher → Files — ONE recording, so the map Places
  grows out of is the same live map through the scene (two page loads laid
  Google's map labels out differently: a whole-map flash at the join);
  `sonata`: Files (unfold scores / music,
  the previews) → Open in Sonata → the Current key Wish (time-lapse) → the P2P
  Wish → its conversation — ONE recording, so the song never jumps at a join;
  `prototype`: the prototype chip (no scroll) → "implement it" → Circle in
  Home; `desktop`: a 1920×1080 desktop at 1.5×, Home's window (half the
  screen, 16:10, up and left of centre — its gallery the full-screen one
  cropped, so the pull-back starts on the very frame it leaves), the montage
  — every app's window laid by hand (`MONTAGE[].at`, CSS px of the work
  area; an entry with a `route` — Deploy's site, a prototype — opens a new
  window and routes it as a link would; a prototype is shown as the app it
  mocks, on Prototypes' chromeless present page
  `present/<id>/live/responsive`, never in the viewer's frame), the apps the
  film has not shown yet first, the ones it has after them, each landscape near 16:10 and at the size its own layout is
  comfortable at (checked one app at a time: never shrink an app to fit —
  overlap more, or open fewer), composed like a photograph (wallpaper on
  every side, the focal window on a third), each landing on top, the Agent
  Manager last and on top — then Home again, taken full screen by its
  window's own control). To try a layout without a
  take: `e2e/montage-preview.ts --composition promo-film [--out <dir>]` lays
  it out in real time and saves a still after each window (it un-hides
  Circle: run it after the prototype take). `film.ts` places them in
  `SEGMENTS` order.
- **Pacing is a fluent user's.** No uniform dwell: the recorder adds none of
  its own (a click is travel + a 0.12 s beat + the press); every pause is a
  `r.hold` in `segments.ts` with a reason (reading a page, an animation to
  finish). Keep holds short; an intermediate step (a detail on the way to its
  photos) is passed through.
- **Pick UI picks the deepest element under the pointer**
  (`ui-context/element-picker`'s `resolveTarget`), so to pick a whole card or
  panel the hand rests on a spot of its own box no child covers
  (`bareSpot`, its padding) — never on a word inside it. An empty
  `aria-hidden` layer (a split row's hit-area) is never picked, so a row's
  padding picks the row; address a panel row by its slot contribution id
  (`songPanelRow`), not by climbing from its label.
- **Scrolling never bounces, and the camera is the film's.** `Recorder.wheel`
  and `Recorder.scrollTo` refuse a scroll past the scroller's end (Chromium's
  elastic overscroll would bounce back). The page never scrolls on its own:
  content an agent writes is framed by `scrollTo` moves (ease-in-out, at rest
  at both ends) whose goals are measured with `Recorder.settledRect` — the
  final layout, readable on the virtual clock before the arrival has played.
  `pages` (`PAGES_CAMERA`): in `staged`, a first move (0.698 s) centres the
  shops' room as the write lands; in both, the follow (0.698 s) starts once
  the first shop (its to-do and place) is in — opaque and at its settled box,
  read off the screen so a slower cascade moves it too — and lands with the
  map centred (±4 px, asserted); `watchScroll` logs the position per frame
  (`pages.json` `input.scroll`).
- **The hand is a person's.** A menu or popover is closed by a click on its
  own trigger or by Escape (the page-kind menu: Escape leaves no focus ring
  since main's fix — check the trigger on the frames after); a launcher
  switch carries the hand on to its next target in the same movement
  (`viaLauncher(…, then)`), never resting on what the new app draws under
  the icon; with Pick UI on, the camera is back at rest before the hand sets
  off. Every move is a reach (the recorder's minimum-jerk `ease`), its
  duration by distance unless a reason says otherwise (a fixed short one
  across the screen is a flick); a path through waypoints may not turn
  sharper than 75° at one (the recorder throws: a dive and a turn back is
  two gestures); a Wish whose next gesture follows at once has no `rest`
  (`rest: null` — the hand goes on from the submit button); a menu opened
  on the way to its item is clicked through in one carried gesture (the
  page-kind menu: trigger, a beat, "Agent page"). The swipe divider is
  performed (`performed` drag profile: slow in, a little past the mark, a
  settle back, the hand's waver) — decisive out, a beat, slower across,
  ending there settled (no trip back home: both variants have been seen).
  A gesture that carries the hand onto a segment's next target (the launcher
  → Files → the scores folder's Expand) is pressed at once in the next
  segment (`unfold(…, { arrived: true })`), never reached for again. Places opens its shop by passing down the list (each hovered
  card's pin lights on the map); Sonata's Current key section is folded
  again by its own header after it is read. A click that opens a full-screen
  app from its top bar (Open in Sonata) carries the hand on to the content —
  resting there would reveal the floating action bar under it; Home is the
  launcher's own click, pressed within its hover intent (the grid never
  shows; asserted).
- **The film's calendar is the seed's, not the recording day's.** The seed
  picks the first Tuesday-to-Friday 15:00 (Paris; `FILM_WEEKDAYS` — two of
  the shops close on Mondays) at or after its own run
  (`seed/core` film-clock: `filmNowAfter`), stamps every "x ago" of the story
  from it and leaves it at `promoFilmWorkspaceDir/film-clock.json`; every
  recording pins its pages' `Date` to it (`installRecorderClock({ date:
  filmDate() })`), so every segment shows the same weekday afternoon (the
  opening-times payoff reads "Open" on every card — `pages` throws on a
  "Closed today"). The P2P agent run
  is stamped with the page's own now. Rows the app writes at real time (a
  Wish's task, the shops' blocks) read as old as the gap from the seed to
  that afternoon (hours, at most ~3 days).
- **Slow motion is the recorder's, never the app's.** `pages` films the
  agent's shops arriving at `PAGES_ARRIVAL_RATE` (0.7×: `Recorder.clockRate`,
  eased in just before the write, back to 1× over the payoff hold) — the
  page clock steps less per frame, so the app's arrival, the camera and the
  hand slow together at 60 fps; the app's own arrival speed is unchanged.
- **No personal name, no machine.** The seed turns the user's name off
  (host-account's `profile-name`: "My pages", the Claude accounts as
  "Claude"), points Home at a stand-in folder (`home-folder`: Files reads
  `Home › Music › Piano`, no volume, disk or checkout), and the
  promo-film composition leaves out the health rows a main restart flickers
  (`debug.sentinel.health-row`, `infra.health.connection-row`), the
  gateway-drift row, host I/O health, and the Database row
  (`database.query-deadline`: on the film's calendar the lock watch's
  server-stamped last look reads as hours overdue).
- **Joins:** every segment but the first opens where the one before ended —
  `continueFrom(<previous>)` (`session-kit.ts`) reads the route it ended on
  (`endHere` writes it to `<name>.facts.json`) and its pointer's last position
  (its own input log). Browser-local state a fresh session lacks is set again
  in the pre-roll (`placesAsLeft`: the remembered map view, Gallery view).
- **`record.ts`** drives the real app on media/film's virtual clock (with a
  steady caret: the harness's `steadyCaret`) into `/tmp/equin-film/session/`:
  each segment's frames and input log, the facts it read off the page
  (`<name>.facts.json`) and every frame's real ms per phase
  (`<name>.timing.json`: settle / step / screenshot — written even when the
  recording fails; a phase over 5 s is logged while it runs). ~0.4 s of real
  time per frame (screenshot p50 ~140 ms). Sonata plays
  silently in the film (the music carries the scene); `sonata-audio.ts`
  serves only `piano-candidates.ts`.
- **Record on battery too — never wait for the charger.** The user charges
  when it gets low; only a battery under ~10 % (where the machine would
  hibernate mid-run) is worth one message, then carry on with whatever needs
  no long run. Host load only slows a recording (the virtual clock absorbs
  it); a screenshot past Playwright's 30 s fails the segment — re-record it.
- **`film.ts`** never records: it opens on the title card (`outro.ts`
  `titleCard`: "A personal OS", then "self-evolving" growing into its place
  in the website homepage's accent gradient — the end card's typography,
  background and reveal (`growingLine`, one tempo for both: `revealKeys`); the
  growth starts and the words leave on the music's beats, and the card fades
  into the session while they are still leaving — cut on motion), places the
  recordings on the timeline
  (`place.ts` time maps — real speed, except each Wish's time-lapse), the
  time-lapse look (`vhs()`: a VHS fast-forward — ▶▶, a running clock,
  scanlines, a tracking band, colour fringing), the glow and push-in on what
  an agent changed, the camera's push-ins on Pick UI and each prompt
  (`cameraMove`: never cuts its target), the desktop pull-back from Home's
  one window, the closing montage (the desktop segment's settled frame after
  each app's window opened, on the music's sixteenths — three readable ~0.7 s windows,
  then each interval ×0.7, the focal window and then Home's window raised
  on that same accelerating cadence — no hold on the focal window
  (`montageIntervals`: the pace in seconds, each cut snapped to a
  sixteenth); every beat a step on the frame grid, so no frame samples
  between two held frames), from Home's cut on real time with the hand
  drawn: it clicks the window's Full screen control and the gallery grows
  into the screen with the window's own motion, the camera pushing in on
  `gallery-frame` in the same movement so the held gallery is the opening
  frame again (same size and place, the hand where it rested at the start —
  the desktop's full screen is 1.5× the film's in CSS px, so without it the
  gallery read smaller than at the start), then the end
  card (`outro.ts`: a direct fade to "equin." with ".ai" growing out of the
  dot, "Free and open source" under it — no URL) and the sound. A recording
  at a larger screen (the desktop's 1920×1080 CSS px at 1.5×) is drawn on
  the film's 1280×720 stage, its logged marks and pointer scaled with it.
  The camera has no motion blur (media/film's default: CSS blur snaps on
  and off mid-move — v21's 0:28 Pick UI pull-back read as a shake).
- **Every render is a new version; nothing is ever overwritten.** The plain
  render writes `~/Downloads/showcase/equin-v<N>.mp4`, N one past the newest
  version there; `--captions` writes `equin-v<N>-captions.mp4` for the newest
  version without one (render the plain variant first, same N); a preview
  writes `equin-v<N>-preview[-k].mp4`. Every full render also writes its
  light web version beside it — `equin-v<N>-web.mp4` (a `--music` render:
  `equin-v<N>-music-<slug>-web.mp4`), what the website streams (media/film's
  `web` option: 1080p H.264 CRF 28, AAC 128k, faststart; ~18 MB for 2 min).
  media/film's `runFilm` refuses any
  existing output path (and its encoder runs `ffmpeg -n`), so there is no
  overwrite path — and nothing to move aside before a render.
- **Auditioning a piano piece:** `e2e/piano-candidates.ts --composition
  promo-film --candidates <a.mid>:<bar>,… --out <dir>` imports each MIDI into
  Sonata the way the film does and saves ~10 s of its real piano sound as mp3.
- **The music is one constant**, `FILM_MUSIC` in `e2e/internal/music.ts` (a
  file, or the pinned `promo-music` dep). Swapping it needs no re-recording.
  To audition another track on the same recordings, `film.ts --music <slug>`
  renders `equin-v<N>-music-<slug>.mp4` (N the newest version) from
  `FILM_MUSIC_TRACKS` — each candidate's file, measured beat grid (the montage
  and end card land on it) and `sectionStart` (whole bars, chosen so the film
  ends on the track's own ending) — leaving `FILM_MUSIC` as it is.

### Re-recording one segment

Every segment opens its own route (the one its predecessor ended on) and
re-records alone; the others' files stay, and `film.ts` re-times everything
after it.

```bash
./equin promo-film seed      # only when the segment WRITES (see below)
./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/record.ts --composition promo-film --only pages
./equin run plugins/apps/plugins/website/plugins/promo-film/e2e/film.ts --preview
```

- Needs a fresh seed first: `pages` (it writes the shops and the map; it
  refuses a Buying a piano page that has them, and turns the cards'
  opening times on), `sonata` (it shows the hidden Current key section
  and finishes the P2P Wish's agent run), `prototype` (it un-hides Circle).
- A segment opens what the one before ended on, and a seed may wipe it (the
  song `pages` imported, the conversation `sonata` ends on): after a seed,
  record every segment again (`record.ts` with no `--only`, ~1 h). Without a
  seed, a segment that writes nothing (`desktop`) re-records alone.
- **A run's config writes end with the run**: the e2e harness reverts every
  config write a run made when it exits (its agent-write revert ledger), so
  `--only pages,sonata` then `--only desktop` would show the montage in the
  seed's state. The desktop segment therefore sets the state the montage
  shows itself (Circle un-hidden, the cards' opening times, the Current key
  section shown), whatever ran before it.
- Joins are continuous only if the neighbouring segments still end and start
  in the same state: after changing where one ends, check the next one's
  opening frame against it.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The equin showcase film (script: the Video page's Script v2): the real app recorded as one continuous session on the seeded promo-film composition (e2e/record.ts), ending on equin's desktop mode, rendered over media/film with a short open-source and end-card tail (e2e/film.ts), and its music track.
- Deps:
  - Uses:
    - `infra/deps.defineDep`
    - `infra/deps/download.download`
  - Exports (values):
    - `PROMO_MUSIC`
    - `promoMusic`
- Sub-plugins:
  - **`circle`** (excluded) — Circle, the film's 'implemented' P2P messaging app: registers the /circle app entry, whose one page is the Circle prototype it was built from, full surface, in its light theme.
  - **`seed`** (excluded) — The showcase film's seed: POST /api/promo-film/seed writes the film's curated story (an organised Pages workspace with the agent's note on the Piano page, a Grieg conversation with its transcript…

<!-- AUTOGENERATED:END -->
