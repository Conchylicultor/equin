# equin showcase film v2: a continuous session, shown not told

## Context

The storyboard is the "Video" page (`block-7304a68b…`). The script is its agent page **Script v2** (`block-5742f007-c2f6-4f02-9453-42e908c1ca0f`), which is the source of truth for what is on screen and when. v1 (`website/promo-video`, never committed; reference copy in `/tmp/promo-v1-ref/`) was deleted: it told the story with headlines and slogans, cut between unrelated scenes, and used a cliché upbeat track. v2 is one continuous session (Pages → agent manager → files → Sonata → Deploy → Places, evolved in place, Circle created from there, zoomed out to the desktop, then the Mac), with no text except optional captions and the end card, and restrained music with deliberate silences.

Outputs: one new version per render pass, never an overwrite — `~/Downloads/showcase/equin-v<N>.mp4` and `~/Downloads/showcase/equin-v<N>-captions.mp4` (N one past the newest), 1920×1080, 60 fps, AAC.

## Layout

| Plugin | Owns |
|---|---|
| `media` (new top-level umbrella) | nothing; groups the two below |
| `media/ffmpeg` | `deps/`: a pinned static ffmpeg + ffprobe (macOS arm64), sha256-checked `download` dep |
| `media/film` | `e2e/`: the generic engine. Asset contract (`assets.ts`, written), composition model, in-page renderer, camera, effects, audio mix and SFX synth, render loop, encode |
| `apps/website/promo-film` | `e2e/capture.ts` (layered stills of the real app), `e2e/render.ts` (this film's timeline + scenes over media/film), `deps/` (the music track) |

The e2e-harness keeps v1's one generic addition: `SessionOptions.deviceScaleFactor`.

## Engine design (media/film)

A film is DATA, not a hand-written paint function:

- **Composition** = stage size, duration, assets, a camera and a tree of layers. A layer is an image (a still, optionally cropped by a rect), a sequence (frame chosen from t), a strip, text, a shape (rect/rounded/glow ring/spotlight mask/cursor), or a group. Every layer property (x, y, z, scale, rotateX/Y/Z, opacity, blur, clip-path, crop) is a keyframe track: `[t, value, easing]` with cubic-bezier and spring easings.
- **Camera** = a track of focus point (in a named layer's coordinates), zoom and 3D tilt; motion blur derived from camera velocity, capped.
- **Renderer**: a generic page script that builds the DOM once from the composition and applies `renderAt(t)` (a pure function of t: no CSS transitions, no timers). The render loop sets t, waits two rAFs, screenshots via CDP and pipes to ffmpeg. The film's scenes are TypeScript that BUILDS the composition; nothing scene-specific lives in the page script.
- **Audio**: music bed (a file, section start, gain automation: duck, cut to silence, fade), audio clips (a capture's recorded sound placed at t), and synthesized SFX cues (whoosh, click, key tick, pop, riser, impact, chime, ding, shimmer) rendered in an OfflineAudioContext. Mixed and loudness-normalized in ffmpeg.
- **CLI flags** for any film script: `--preview` (640×360, 30 fps), `--from/--to`, `--stills t1,t2 --stills-out dir`, `--out`, and the film's own variant flags (here `--captions`).

## Capture (promo-film/e2e/capture.ts)

Against main (`--url http://equin.localhost:9000`, read-only: staging is DOM injection and UI-only interaction, never a write). Viewport 1280×720, DPR 2. Every shot is a full-frame still plus the rects of every element a scene animates, so the composition can lift panes, icons and popovers out of a still as separate layers. Fails loudly when an asset or rect is missing. The shot list is in the capture brief and follows the script section by section.

## Execution

1. In parallel:
   - **Music** (Sonnet): find, license-check and declare the track; report BPM, structure, and where the three silences can fall.
   - **Engine** (Opus): `media/ffmpeg` + `media/film`, verified by a small test film.
   - **Capture** (Sonnet): `capture.ts` and the asset set.
2. Me: the timeline and scenes in `promo-film/e2e/render.ts`, cut to the track; preview renders; frame review.
3. Full renders of both variants into `~/Downloads/showcase/`.

## Verification

- `capture.ts` writes every asset in its shot list with every rect present.
- `render.ts --preview` and `--stills` at each section boundary, reviewed as PNGs.
- `ffprobe` on the outputs: 1920×1080, 60 fps, AAC stereo, about 64 s.
- `./equin check boundary-rules plugin-boundaries type-check`.

## User feedback on v0 (2026-10-29) — standing preferences

Recorded verbatim in spirit; future passes tune to these. To be mirrored on the Script v2 page.

**Principle: one continuous, real session.** The film must read as someone actually using equin — real UI transitions driven by real clicks, not stage transitions between stills. Invented cross-fades, fake zoom+slide pane expansions and reflow double-images break immersion. Scripted motion is fine for the *camera* (zoom to focus) and for driving inputs (cursor, typing, a slider sweep), never for the app's own UI.

- **Intro:** far too long — ~10 s on a static gallery with odd icon effects. Cut hard.
- **Integrated:** one session, not many short segments.
  - Opening the conversation from the chip must look like a real click opening the pane.
  - A new pane opens at 50% width beside the page (v0 squeezed it into the right edge).
  - Expanding a pane happens through its real Expand button, not a fake zoom+slide.
  - Files: the conversation opens a file *preview*; Expand on the preview opens the same file in the file explorer (main 23fb49165f: file-preview Expand → Files).
  - Files → MIDI file → Sonata: continuous, real navigation; clicking "Sonata" opens the app as the app really opens.
- **Other apps montage (Places/Deploy/…):** must clearly read as a quick tour of other apps — v0 showed Deploy for half a frame, blurred, unreadable. Each app legible. Add Chord.
- **Evolving:** zoom in on the "Pick UI element" button when it's used, and on the Wish prompt field while typing.
- **Typing:** smooth per-character typing like a promo video (not words popping in).
- **Create / prototype:** show the real transitions — visible clicks on mobile, on side-by-side. The slider UI must be the app's real one (its sweep may be scripted, the UI truthful).
- **Sound:** SFX much more subtle; no whoosh on every transition (feels cheap).
- **Music:** try a different track. Never stop the music to let Sonata's piano be heard — keep it running (duck at most).

## As built (2026-10-30): one recorded session

The still-based capture and scenes (`capture*.ts`, `intro`, `integrated`, `more-apps`, `evolving`, `create`, `render.ts`, `record-test.ts`) are gone. The app part is now the REAL app recorded on media/film's virtual clock, on the seeded `promo-film` composition (`promo-film/e2e/record.ts`, segments in `e2e/internal/segments.ts`), and `e2e/film.ts` renders from the recordings:

- Segments join only where the session is continuous or at a deliberate cut (the app tour; the two time-lapses). Real speed everywhere except the time-lapses (5×) and Sonata's ~2 s sample-loading wait after the first Play (6×, a still picture).
- The evolve's change is written into the Pages page during its time-lapse through the editor's own create-block endpoint (what the task's agent writes); the filed tasks are never launched (not main).
- Invented: the desktop reveal (the prototype's last frame, aligned on the window's phone, gives way to the window's own pixels as the camera pulls back), the Mac, the iceberg, the open-source card and the end card (centred by layout: `calc-size()`).
- The virtual clock now also drives `AudioContext.currentTime` (a player's playhead moves at film speed); Sonata's sound is captured separately in real time and placed on the playhead's start.
- Music: one constant, `FILM_MUSIC` (`e2e/internal/music.ts`).

## Second pass (2026-10-30): the Wish, several times; ending on the desktop

Script: the Script v2 page; code: `promo-film/e2e/internal/segments.ts`. No Deploy, Mac or iceberg; the film ends on equin's desktop mode (a short open-source + end-card tail, `TAIL` in `internal/film.ts`).

- The recital piece is Chopin's Fantaisie-Impromptu, Op. 66: the Mutopia Project's public-domain MIDI, committed in the seed's `data/music/` (the Rachmaninoff Prelude Op. 3 No. 2 on Mutopia is CC-BY-SA, not PD/CC0/CC-BY).
- Sonata's Wish shows the Current key section through its real layout setting: the seed hides it (`hidden` in the section slot's config_v2 layout, user layer); the film's agent change is the Config pane's reset-field write.
- The Lisbon Wish writes `place` blocks (Google ids, resolved by the page) and a `map` block through the editor's create-block endpoint. Places' cards show real photos because the seeded places are now Google places by id (details fetched at seed through the importer's path); before, they were custom places with no Google id, so the gallery had nothing to fetch a photo for.
- Engine: `cameraMove` (focus/zoom keys that move the VIEW's edges, so a push-in never slides off its target mid-move — what cropped the Pick UI element pill) and a frameOn assertion; the clock starts a lazy image in view at once (else a recorder waiting for it before the capture deadlocks with the rendering step that would start it); the harness's `steadyCaret` (macOS's non-blinking caret setting for the headless shell) — a blinking caret runs on the real clock and flickered across virtual-clock frames.
- Open: "expand the map into the Places app" is not on main yet (the join is the app launcher for now); a truthful "Circle appears in the Home gallery" needs Circle to exist as a real app plugin.

## Third pass (2026-11-02): Script v3 — a story, with principles

The user's feedback on v2 was distilled into **Principles** at the top of the
Video page's Script v2 page (block-5742f007-c2f6-4f02-9453-42e908c1ca0f) —
high-level rules, not fixes: a real person using a real OS; every move has a
reason inside the story; actions a real user would take (Pick UI rather than
words, Auto-push only for a small app change); a lived-in, organised workspace;
agents write information; time passing and an agent's change made visible;
one subject per frame; the music never stops (Sonata silent). The script that
follows them, as built:

- **Seed.** An organised Pages workspace (~30 nested pages with icons; the
  fixture writer gained `icon` and `expanded: false`); the Grieg conversation's
  note on the Piano page written through the real `edit_page` as that
  conversation (so the note's name opens it); twenty agent runs; the score
  (PDF + first page as PNG) and MIDI of Grieg's Wedding-day at Troldhaugen
  (Mutopia 781, public domain); places from Paris to Bergen and Vienna; Circle
  hidden; `POST /api/promo-film/agent-run` finishes the P2P Wish's agent run
  during its time-lapse.
- **Circle as an app** (`promo-film/circle`): an app entry whose page is the
  prototype, light theme. Hidden from every launcher by apps-core's new
  **Hidden apps** setting (`hiddenAppsConfig`, read by `useAppListing`; the
  committed default lists `circle`); the recording sets it to `[]` and the tile
  appears in Home. A composition-only plugin was the first design and is not
  expressible: a `base-exclusions` negative cannot be taken back by `promo-film`
  (`**`) — `composition-closure` refuses a named positive (contradictory
  negative) and a selected contributor (already required).
- **Film.** Segments `integrated` (Pages → note → Agent Manager → score image
  → Files → music → Sonata, silent; Wish with Pick UI and Auto-push; the
  section appears), `gear` (shops Wish → map → Open in Places → a notch-by-notch
  zoom out to Europe → P2P Wish → its conversation), `prototype` (the chip →
  Expand → canvas → "Good, implement it" → Home, Circle's tile → Circle),
  `desktop` (one window). Every time-lapse wears a VHS fast-forward; the
  agent's changes get a glow and a push-in; the end is a direct fade to the
  equin.ai card with "Free and open source · github.com/…" under it.

## Fourth pass (2026-11-03): making the recording reliable

- **Screenshot stalls are host starvation, not a recorder bug.** Every frame's
  real ms per phase is now recorded (`<segment>.timing.json`, media/film's
  recorder; a phase over 5 s is logged while it runs). At load 3–20 a
  screenshot is p50 ~145 ms, p99 ~350 ms; the stalls came with load spikes:
  5–15 s screenshots at load ~54, the one 32 s timeout (Playwright's default
  30 s) at load ~84 — when a Virtualization.framework VM outside equin's host
  admission ran at ~600 % CPU and the laptop, drawing more than its charger
  gives, was at 1 % battery (it hibernated 03:01–03:10 mid-recording; the
  virtual clock made that a no-op in the film). An exclusive equin host slot
  would not have helped: the competing load was not equin's.
- **The un-typed Wish prompt** was a click aimed once at a moving target: after
  Pick UI the Wish popover slides into place as the action bar collapses, the
  pointer travelled to where the editor had been, landed outside the popover
  (dismissing it), and the typed keys went to Sonata (space = play). The
  recorder now re-aims an element target on every frame of a move and of a
  click's dwell (media/film CLAUDE.md).
- **Segments are one scene each** (`pages`, `sonata`, `shops`, `places`,
  `prototype`, `desktop`), each opening where the previous ended
  (`continueFrom`: its route and pointer), so a failure costs one ~10 min
  scene, not a 40 min run.
- **The WebGPU-off init script is gone**: the stalls followed host load with
  or without it.
- Script fixes found by recording: Gear is opened from Pages' recent pages
  (it is nested, Music › Piano › Gear); the zoom out flicks until the map's
  remembered zoom reaches Europe's scale (7 × 120 px only reached Île-de-France);
  the seed's agent-run lookup matches a Wish filed with its Page URL (the
  description then carries the page under a rule).
- Also found while recording: Home is not in the launcher grid (the launcher's
  own click is Home), so the film takes the grid's "All apps" line; the
  section glow framed a 40 px button (now the box holding the header and the
  opened body); the desktop window was never resized — desktop windows lost a
  resize (and a titlebar drag) as soon as the pointer crossed the window's
  iframe content: both now capture the pointer (`desktop/windows`), and the
  segment drags the bare titlebar, not the tab chip (which has its own drag);
  the VHS fringes sent `[t, v, null]` keys (an `undefined` easing through
  JSON), which crashed the render at the first time-lapse.

## Fifth pass (2026-11-03): Script v4

- **The seed reset's intermittent failure was PgBouncer's login cache.** The
  reset dropped the composition DB then created it; in between, PgBouncer
  re-dialled the missing database itself (`min_pool_size = 5` refills a pool
  whose server connections the `DROP … WITH (FORCE)` cut) and the
  still-running backend reconnected. The failed login is cached for
  `server_login_retry` (15 s), so the backend restarted onto the recreated DB
  within that window was refused ("server login has been failing, cached
  error: database … does not exist") and booted on no schema
  (`graphile_worker._private_known_crontabs does not exist`). Intermittent
  because it depends on the restart landing inside 15 s of a failed dial.
  Fix: `database/admin` `recreateDatabase` — `KILL <db>` on the PgBouncer admin
  console (as the `pgbouncer` user over the Unix socket: drops the pool, its
  cached failure with it, and pauses logins), drop + create, `RESUME <db>`.
  The reset uses it; no window remains in which a login can fail.
- **Script v4** (Video page, Script v2 → "Script v4"): Pages → the user's own
  "Buying a piano" page (Music open in the sidebar) → the shops written live
  (no time-lapse: an intro line, the places, a map) → one smooth scroll → the
  map's expand → Places: a shop's detail, then Pick UI on a card → "Add
  opening times to the cards" (Auto-push, time-lapse; the place-cards setting
  turns the hours on and they ease in) → the launcher → Files (the Piano
  folder: unfold scores → a score page's preview, unfold music → the MIDI) →
  Open in Sonata (Sonata grows out of the button) → the Current key Wish
  (the section animates in) → the P2P Wish (no time-lapse) → its
  conversation → Prototypes → "Good, implement it" → Circle in Home → the
  desktop pull-back from the Home window → the montage (every app opening in
  a window of its own, one beat each, faster and faster: the film keeps one
  settled frame per app) → Home full screen again → "equin." + "Free and open
  source" (no URL).
- Segments are now `pages`, `places`, `files`, `sonata`, `prototype`,
  `desktop`. `Recorder.mark` takes a measured rect too (the desktop window's
  content box, below its titlebar, which no element bounds alone).
- **Rendered** as `~/Downloads/showcase/equin-v5.mp4` (161.2 s; stills every
  2.5 s in `~/Downloads/showcase/review/v5-stills/`). App changes it needed:
  Open in Sonata grows Sonata out of the button (`useMorphFromElement`, pane
  web — the morph's view transition is advanced by the recorder's clock) and
  continues the preview's playback (a one-shot play-on-open intent, never in
  the URL); a layout's un-hidden render-slot item eases in (`Reveal` /
  `useRevealedLater`, css/motion, applied by reorder's list middleware);
  Places' place-cards setting shows today's opening hours on the panel's
  cards and on a page's places (`showOpeningHours`, eased in); Files opens
  on its `startFolder` config.
- Found while recording: a wheel over a Google map zooms the map, not the
  page — the scroll to the map keeps the pointer above where the map lands;
  the drilled card's Back line in a page's places reads "<page> · 1 of 4".
- Open: the shops are written below the fold of a short page (the page
  cannot scroll further before they exist), so only their first lines appear
  live; the app's greeting ("Good morning") follows the real recording time
  while the time-lapse clock shows the afternoon; the transcript's Write shows
  the host's real prototypes path; a fresh-DB composition boot under host load
  can miss the gateway's readiness deadline and be killed repeatedly before it
  converges (seen 03:20–04:15 at load 10–25).

## Sixth pass (2026-11-04): fluent rhythm, no jumps

Feedback on v5 (`~/Downloads/showcase/equin-v5.mp4`), all against the Video
page's updated Principles:

- **Pauses after every action** were `r.hold`s in `segments.ts` (1–2.6 s after
  most clicks, 0.45 s in every Wish step), not the recorder: a click is travel
  + a 0.12 s beat + the press. Every hold was re-cut to its reason (reading a
  page ~2 s, an animation to finish), the Wish's own steps to 0.15–0.35 s.
- **The overscroll bounce** was the first scroll of `pages`: it asked for more
  than the short page had left, and Chromium's elastic overscroll bounced back
  (frames 408–432: the title over-shoots by ~10 px and returns).
  `Recorder.wheel` now refuses a `dy` past the scroller's end (it would
  bounce), and live content is followed by the new `Recorder.scrollAlong`
  (media/film): every frame scrolls toward "the newest block's bottom + a
  margin" on a trapezoid profile (accelerate, cap, brake exactly at the goal;
  never past it, never back up) — one movement while the agent writes.
- **Buying a piano** is now short: two lines of context, then the user's
  checklist "Shops to try" — Pianos Beaumarchais ticked with its place under
  it, Paul Beuscher ticked and Steinway & Sons unticked as bare names. The
  agent fills their places in, adds Pianos International, Pianos Daudé and
  Nebout & Hamm (each a to-do with its place), then a map. The Pages fixture
  gained nested blocks and `place` blocks.
- **Places grows out of the page's map**: Open in Places uses the same
  `useMorphFromElement` as Open in Sonata, from the map block's box
  (`morphOriginProps`); the shared pane morph is longer (720 ms, a strong
  ease-out, the cross-fade only its first 22 %).
- **The opening-hours jump**: `Reveal`'s wrappers were real boxes while
  revealing, so the hours line (an inline span) took the wrapper's body
  line-height strut — taller lines, the next card pushed down — and snapped
  back when the reveal ended (`display: contents` at rest). The reveal body
  is now a flex column, blockifying the child exactly as at rest
  (`css/motion` `reveal.css`; Sonata's section reveal shares it).
- **Pick UI** picks the deepest element under the pointer
  (`resolveTarget`); picking "store" was the hand resting on the card's text.
  The film now aims at a bare spot of the card's own box (`bareSpot`).
- **Sonata's notes jumped at the files→sonata join**: a fresh session reopened
  the song paused at the URL's bar and pressed Play in real time. Files and
  Sonata are now one recording (`sonata`), so the song simply plays on.
- **The montage flicker** was the time map: each beat's step was a 1/60 s
  linear ramp between two held recording frames at times off the frame grid,
  so a film frame sampled the ramp and showed the launcher or a half-open
  window. Steps now sit on the frame grid with a 1e-4 s jump.
- **The montage** records a 2560×1440 CSS-px desktop at 1x (the same pixels,
  twice the room); Home's window has the film's own 1280×720 content (so the
  pull-back lands on the gallery's very layout); every app's window is laid
  into a 6 × 3 mosaic (Agent Manager a 2 × 2 hero, Pages / Sonata / Circle
  2 × 1, the rest single cells; 40 px margins, 20 px gutters).
- **The end card** is "equin.ai" again (".ai" growing out of the dot, the
  word recentred by layout), "Free and open source" under it.
- **No username on screen**: the conversation view shows a path under the
  home folder as `~/…` (`tildifyText` / `useHomeDisplay`, host-account; in
  file paths, Bash and the agent's prose).
- **Found while recording:** the recorder waited for a not-yet-rendered
  element with a plain Playwright wait — the page's clock stands still
  then, so a popover still opening could never appear (the Wish editor timed
  out at 30 s). A move/click target is now waited for frame by frame on the
  page's clock (media/film). `scrollAlong` reads its target with
  `evaluateAll` (no wait), since a block just written is re-rendered between
  two calls. The map → Places morph first did not grow: Places' leaf pane
  mounts frames after the navigation commits (a lazy app), and `/places` is
  the app's index pane, absent from the route chain the leaf lookup read — the
  morph now waits (≤ 1.5 s) for the leaf box and falls back to the tab's last
  pane box; a stamped origin's new picture has no fade-in (a blank box showed
  for a frame). One seed POST answered 500 once and succeeded on the next run
  (not investigated: its logs were reset with the DB); one run lost its
  backend to a cluster restart ("database system is shutting down", cached by
  PgBouncer's login retry) and passed on the re-run.
- **Recorded** pages 19.1 s (was 31.3), places 24.8 s (was 29.9), sonata —
  Files included — 39.4 s (was 17 + 45.5), prototype 33.7 s (was 39.4),
  desktop 56.3 s; the film is ~116 s (v5: 161 s).
- **Open:** the montage's Places window opens on a map view holding none of
  the places ("None of the 35 places are in view"); the Agent Manager's
  sidebar footer shows the Claude account name (`conchylicultor`) in the
  montage and the conversation scenes; Prototypes' Phone switch reflows the
  frames in one step before their size animates (the app's own transition).
- **Rendered** `~/Downloads/showcase/equin-v6.mp4` (115.9 s; stills every
  2.5 s in `~/Downloads/showcase/review/v6-stills/`). After v6: the ending was
  Home's window → Full screen on the 2560 px desktop, which lays the gallery
  out small and far from the opening frame; the film now ends on Home's
  window raised over the mosaic and the camera pushing into its content
  (1280 × 720 CSS px = the opening gallery exactly; `film.ts`, `END_HOLD`),
  and `segments.ts` no longer clicks Full screen. The desktop pre-roll now
  remembers a Paris map view (Places' window still read "None of the 35
  places are in view": its narrow map is mostly under the panel). The desktop
  was re-recorded with both; the v7 render was killed mid-way (a broken
  partial `~/Downloads/showcase/equin-v7.mp4` — leave it; the next render is
  v8).

## Seventh pass — handoff (2026-11-05)

The sixth pass's agent stopped here (context full). Feedback on v6 and the
updated Principles / Script v4 are on the Video page's Script v2 page
(`block-5742f007-c2f6-4f02-9453-42e908c1ca0f`): read them first. State to
start from:

- **On disk** (`/tmp/equin-film/session/`): pages, places, sonata
  (Files + Sonata + the P2P Wish + its conversation, one recording),
  prototype, desktop (the newest, with the push-in ending) — all from one
  seed, consistent. `film.ts` renders them as they are (v6 + the new ending).
- **Recording facts worth knowing:** the e2e harness reverts the run's agent
  writes (config documents) when a run ENDS, so a segment that failed after a
  config write can be re-run without a seed, while one that wrote page blocks
  (`pages`) or an agent run (`sonata`) needs `./equin promo-film seed` and
  then every later segment again. A screenshot past 30 s (host load) fails a
  segment: re-record it. `--skip-checks` builds of the composition take ~5–10
  min; never edit `.ts` while a build's tsc runs.
- **Where things are:** `segments.ts` — `wish()` (Wish steps and pacing),
  `bareSpot` (Pick UI on a whole box), `scrollAlong` use in `pages`,
  `placeCards` (innermost keyed row), `placesAsLeft` / `rememberMapView`,
  the `sonata` section rect (largest box around "Current key" without
  "Circle of fifths"), `DESK` / `MONTAGE` / `placeWindow` /
  `markWindows` + `tagNewWindow` (the desktop). `film.ts` — `pushIn` (the
  push-in is `cameraMove` over `dur` 0.6–0.7 s: the "too fast zoom-in"),
  montage steps on the frame grid, desktop rect scaling (`loadAssets`), the
  end push-in. media/film `record.ts` — `move` eases each call on its own
  (`inOutCubic`), so two chained `r.move`s (e.g. `openBar`'s two legs, or a
  move then a click's own move) read as move-pause-move: the cursor item is
  in the segments' chained moves, plus `click`'s 0.12 s dwell.
- **Pointers for the new items:** the page-type menu is the "Page ▾" button
  in a page's header (Page / Agent page / Instructions); Places' header photo
  opens the "Photos · <place> · N from Google" grid (the v6 take clicked a
  strip thumbnail → the image viewer); the health dot is the shell's
  health-report dot (`shell/health-report`), whose rows (connection, database
  query deadline, Claude Code, MCP…) can flip under recording load — find the
  row that changes, don't paint over it; the account footer in the Agent
  Manager sidebar shows the Claude account login (seen as `conchylicultor`
  and `etiennefg.pot`) — it needs a composition- or seed-level stand-in
  account name, not a personal one.
- **Open from v6** (besides the new feedback): Open in Sonata restarts the
  song at its bar start (the preview was mid-bar; `bar` param, whole bars
  only); Files' breadcrumb shows `Home › .equin › cache › promo-film ›
  Piano` (the seed's workspace path); Prototypes' Phone switch reflows in one
  step before its size animates.

## Seventh pass (2026-11-05): pacing by information, one gesture per move

Feedback on v6 (`~/Downloads/showcase/equin-v6.mp4`) and the Principles'
new pacing / montage / health-dot rules (Video page, Script v2):

- **One gesture per move.** The move-pause-move was every chained
  `r.move` (each eased on its own, so it stopped at its end): `openBar`'s
  two legs, `unfold`'s row-then-chevron, the prototype's frame-then-rail.
  media/film `Recorder.move` (and `click`) take `via` waypoints: one smooth
  path (Catmull-Rom, walked by arc length) under ONE ease — the hand curves
  around what it must not hover and never stops on the way. `unfold` now
  moves straight onto the row's leading box (the chevron appears under the
  hand); the map's Open in Places is one click gesture across the map.
- **Pacing.** `wish()` takes a `pace`: the first Wish (Pages) unfolds slower
  (each step held a beat longer, the prompt read back once), later ones are a
  practised user's. Payoffs get a held beat (the completed list and its map
  1.0 s, the new section 1.2 s then opened), routine steps are short and the
  next gesture starts as the previous result settles.
- **The opening of Buying a piano** is no longer a still 2 s: the hand drifts
  slowly up to the page-type menu while the page is read, and the user
  switches it Page → Agent page (the header's "Page ▾" pill, its panel read
  once) before the Wish — Script v4's new first step.
- **Camera.** `pushIn` arrives AT its moment instead of starting there: 1.2 s
  in on a soft-start, long-settle bezier, 0.8 s back out (was 0.6–0.7 s both
  ways, linear-ish `inOutCubic`).
- **Cut to the music.** The track's beat grid is measured once and declared
  with the file (`music.ts` `beat`: 172.2 BPM, first beat 0.144 s —
  onset-envelope autocorrelation): film.ts starts the track so the montage's
  first window lands on a bar, lands every montage window on the sixteenth
  grid, and the end card's fade on a beat. Earlier scenes follow the
  recording's real time (not re-timed to the grid).
- **Places' photos** are the photo GRID: the detail's header photo →
  "Photos · <place> · N from Google" → Back → the card's Back line.
- **Sonata's Wish** picks the Feel ROW (the row the section goes under) with
  "Add a section below to show the song key"; the highlight fires as Current
  key appears, then the user opens it.
- **The montage** is a desktop someone arranged: 1920×1080 CSS px at 4/3
  (the same 2560×1440 pixels, windows readable — v6's 2560 CSS px at 1x made
  them small), windows at hand-placed fractions of the work area
  (`MONTAGE[].at`), varied sizes overlapping in depth, wallpaper around them,
  the Agent Manager opened last as the large focal window; Places' window
  lists every place (the panel's All scope, set in the pre-roll).
- **The health dot, diagnosed.** Every recording now logs each change of the
  dot (its `data-health` state and verdict, the button's accessible name) on
  the page's clock to `/tmp/equin-film/session/<name>.health.json`, and warns
  when it leaves ok during the recorded part (`watchHealthDot` /
  `reportHealth` in `segments.ts`). Found: (1) **Gateway "Out of date"**
  (`infra/launcher/gateway-drift`): attention for the WHOLE film — the
  machine's login-service gateway is older than what main would install (a
  real machine state, cured by updating the gateway, which an agent may not
  run). The `promo-film` composition now leaves that plugin out
  (`config/plugin-meta/composition/compositions.origin.jsonc`:
  `"!infra.launcher.gateway-drift"`) — a developer machine's maintenance row
  has no place in a user's film. (2) **Main redeploying under the film**: a
  critical "Main is not running its machine watcher" (`debug/sentinel`) and
  an attention "Reconnecting to central…" (`infra/health` Connection) for a
  few frames, when main (which hosts central and the watcher) restarts after
  another agent's push. Machine noise from outside the story; NOT fixed yet.
  (3) During the unrecorded pre-roll: "Connecting to central…", the duress
  activity mark ("Under duress since … · builds held back").
- **Account name**: a `claude-accounts-display` config
  (`infra/claude-cli/accounts`, `standInName`) the served `claude-accounts`
  value applies (the accounts file untouched); the seed sets "Alex Martin".
- **Seed**: the first `./equin promo-film seed` after a rebuild failed once
  inside `readEndpointResponse` (the POST answered an error); the re-run
  passed (as in the sixth pass; not investigated).

## Eighth pass — handoff (2026-11-05)

The seventh pass's agent stopped here (context). State:

- **Built and seeded**: the `promo-film` composition (build-1793852828,
  without gateway-drift), seeded. A full `record.ts` run (all five segments,
  the new script) was started 2026-11-05 ~05:25 into
  `/tmp/equin-film/session/` (log `/tmp/film7/rec-all.log`); check it ended
  `EXIT 0` and read each segment's health warning. pages and places
  recorded (contact sheets checked: the page-type switch, the photo grid, the
  hours); sonata failed at the Feel pick (no bare spot: the row's button
  fills it — `songPanelRow` now descends to the deepest box that is the whole
  row) before writing anything, so sonata, prototype and desktop were
  re-recorded without a seed (log `/tmp/film7/rec-3.log`; the host was under
  duress, ~1.2 s per frame).
- **Not rendered**: v8 is still to render (`e2e/film.ts`; media/film's
  parallel render has landed — `--workers`). Then stills, and check them
  against the Principles and the 8 points of the v6 feedback.
- **Untested by eye yet**: the organic montage layout (`MONTAGE[].at` — tune
  fractions from a desktop frame), Places' "All" pre-roll click in `desktop`
  (a guessed locator: a button/radio whose text starts "All"), the Sonata
  Feel-row pick (`songPanelRow`) and opening Current key, the Places header
  photo → grid (`img.cursor-zoom-in`, "· N from Google"), `unfold`'s single
  gesture onto the row's leading box.
- **Open**: (a) the health dot's main-restart noise (sentinel row critical,
  central reconnecting) — options: the Connection row and the Machine
  watcher row show a transient (re)connect / restart only once it outlasts
  a short grace (a real UI fix: a sub-second blip is not news to a user), or
  leave `debug.sentinel` out of the film's composition too; (b) "Etienne's
  pages": the Pages brand reads the host account's full name — the film needs
  a stand-in host account (`infra/host-account` has a `guest` provider, Alex
  Morgan, for hosts without the computer; a composition-level choice of it,
  or a display-name config like the Claude one); (c) Files' path bar still
  reads `Home › .equin › cache › promo-film › Piano`: the seed's workspace
  is a cache data dir under `~/.equin`; reading like a user folder needs
  either the seed to write into a real home folder (e.g. `~/Music/Piano` —
  touches the user's home; ask first) or a Files notion of a display root;
  (d) Sonata's Open in Sonata restarts at a bar start, Prototypes' Phone
  reflow (from v6).
- **Where it stopped (sonata blocker).** sonata, prototype and desktop are
  NOT re-recorded: the sonata take fails before its Wish at the Feel pick —
  first "no bare spot", then (after `songPanelRow` descended to the deepest
  whole-row box and took the visible label) "the Feel row has no box": the
  element `songPanelRow` tags (`data-film="feel-row"`) has no box when read
  back. Next step: inspect the song panel's DOM around "Feel" with the
  `browser_*` tools on the composition (Sonata open on the Grieg song) and
  pick the row's real element (its button / `data-ui-owner`) by a stable
  selector rather than the label climb. Nothing was written by the failed
  takes, so after fixing it re-run `record.ts --only sonata,prototype,desktop`
  without a seed (pages and places on disk are this pass's). On disk now:
  pages and places (new), sonata / prototype / desktop from the sixth pass
  (do not render a mix).

## Eighth pass (2026-11-05): the Feel pick, the drift row, v8

- **The Sonata Feel pick, root cause.** A section header is a split `Row`
  (a box holding the disclosure `<button>` and the actions cluster), and
  the split row's `aria-hidden` hit-area span (`absolute inset-0`, so the
  padding stays clickable) covers the WHOLE row box. Pick UI picks the
  deepest element under the pointer, so every spot of the row — padding
  included — resolved to that empty span: hence "no bare spot" (bareSpot
  saw the span cover everything), and the label-climb fallback then tagged
  the slot's `display: contents` contribution wrapper ("no box"). The same
  held for the user: Pick UI on any split row's padding handed the agent a
  label-less `span`. **Fixed in the picker**
  (`ui-context/element-picker` `resolveTarget`): an empty `aria-hidden`
  element is decoration and is never selected; a pick seeded on one starts
  from the nearest ancestor whose box holds the point (the hit-area escapes
  its parent button). Test: `resolve-target.test.ts` "a split row's
  hit-area layer resolves to the row". `bareSpot` mirrors the rule, and the
  film addresses the row by the section's slot contribution id
  (`[data-contribution-id="apps.sonata.rich.swing:feel"] :has(> button[aria-expanded])`
  — the header box holding the disclosure control), no label climb. A
  chained Playwright `.locator(":scope :has(…)")` matched nothing; the one
  plain CSS selector does.
- **Places "All"**: the guessed locator's first match was the sidebar's
  "All places" preset row, not the panel scope. It is the `radio` "All 35"
  (In view | All), remembered in browser storage across reloads (checked):
  `getByRole("radio", { name: /^All\b/ })`.
- **The gateway-drift exclusion was not in the tree.** The seventh pass's
  `!infra.launcher.gateway-drift` never reached the composition registry
  (no diff, absent from `compositions.origin.jsonc`, which is generated):
  the v8 build re-included it and the sonata take logged "Out of date" for
  its whole length. Now in the seed default itself
  (`plugin-meta/composition/core/config.ts`, the promo-film row's
  `entryPoints`), regenerated into the origin by the build. **It takes two
  builds**: the first resolves the composition from the old origin before
  regenerating it (1609 plugins, the registry artifact unchanged, the row
  still drawn); the second shows 1608 (filed:
  task-1793864358-6w5rvd). Since the failed take had written (the Current
  key reset, the P2P agent run), the composition was reseeded and every
  segment re-recorded (log `/tmp/film7/rec-v8-all.log`). The first seed
  after a rebuild failed again in `readEndpointResponse`; the re-run passed.
- **Account name**: "Alex Martin 2" on the footer — the active account on
  this machine is the second added one, and the stand-in numbered from the
  first. `withStandInNames` now gives the ACTIVE account the plain name and
  numbers the others (test updated). Not in v8: needs a composition rebuild
  and a re-record of sonata / prototype / desktop (sonata writes, so a
  reseed and every segment).
- **Desktop**: the montage failed on Chord's window (326 px wide < the
  desktop's `MIN_W` 360; `MIN_H` 260 too): Chord, Tap Tap Party and Circle
  resized (≥ 0.19 of the width, ≥ 0.27 of the work area's height).
  `desktop` re-recorded alone (it writes nothing).
- **v8**: `~/Downloads/showcase/equin-v8.mp4`, 118.48 s, 1920×1080 @ 60
  (6 parallel pages, 561 s). Render with `--composition promo-film`: the
  checkout's own deploy (built 12 h before) answered 502 "backend spawn
  failed: readiness timeout" to the harness's agent-write revert. Stills
  (one per 2 s, sheets of 12): `/tmp/film8/stills/sheet-0{1..5}.jpg`;
  the settled montage `/tmp/film8/montage-final.jpg`.
- **Verified in v8**: the page-type switch, the photo grid, the hours with
  their highlight, the Feel pick (chip) → Current key appears highlighted →
  opened (D major), the organic montage (Agent Manager focal, on top),
  Places' window lists every place (All), the end card.
- **Still missing a Principle in v8** (not fixed):
  - Machine noise: main restarted repeatedly during the recording (other
    agents' pushes): the dot goes critical "Main is not running its machine
    watcher" / "Reconnecting to central…" for a few frames in pages, places,
    sonata and prototype (open question (a) — the user decides).
  - "Alex Martin 2" (fixed in code, not re-recorded — above).
  - Pick UI's chip labels run words together: "FeelStraight",
    "1Pianos Beaumar…" — the picked box's name is its text content with no
    separators (ui-context's element descriptor); a real app wart.
  - The Wish bar: the hand hovers the collapsed bar open, rests ~0.25 s
    while it unfolds, then a short second move to Wish / Pick UI (sonata
    11.95 s, 31.4 s; places 5.8 s; prototype 15.9 s) — a reveal-then-aim,
    reads as a small move-pause-move. `unfold` likewise: onto the row, then
    a few px onto its chevron.
  - Files opens with the hand resting on the sidebar's Trash (the join
    from the launcher), and the path bar `Home › equin › cache ›
    promo-film › Piano` (open question (c)); "Etienne's pages" (open (b)).
- **Pre-existing**, unrelated: `plugin-meta/composition` test "the demo
  profile is the agent manager and Pages minus machine-only surfaces"
  fails at HEAD (`agent-manager-demo` has a positive `apps.prototypes.**`).

## Ninth pass (2026-11-05): every window gives its app room to breathe

Feedback on v8: the montage's apps looked compressed — Pages squeezed
(narrow cards, wrapped text, its list cut at the bottom), Chord truncated on
the right and bottom. v8 sized every window as a fraction of the work area
(as small as 0.19 of the width: Chord at ~365 CSS px). New Principle (Script
v2): *every window gives its app room to breathe* — open it at the size its
own layout is comfortable at; when that leaves too little room, overlap more
or show fewer, never shrink an app to fit.

- **Sizes chosen per app, checked one by one** (each app alone at its
  window's content size in the browser, then each `opened-<i>` frame of the
  take): Pages 980 × 700 (three cards on one line, the recent list whole),
  Sonata 1060 × 470 (the library's four cards on one row — at 980 the fourth
  wraps below the edge), Files 820 × 450, Places 1180 × 620 (the map shows
  between its two panels; at ~980 it is all panel), Chord 970 × 715 (single
  column: the song row unwrapped, the window's edge falls just after the piano
  card — at 1000 the trainer's `@[1000px]` container breakpoint splits it
  into two columns, both squeezed: "Now listening" wrapped, the title gone,
  the side card cut — the take-3 failure), Tap Tap Party 600 × 420, Circle
  480 × 720 (a phone-width column, the whole conversation), Agent Manager
  1080 × 700, last and on top, right of centre so Tap Tap Party's tiles
  still show beside it.
- **Density: 8 windows (was 12)** over Home. Dropped Events (an empty
  state), Settings (a config tree), Browser (a blank start page), Prototypes:
  little to show, and no room for them at a comfortable size. The windows
  overlap heavily, each landing on top; the wallpaper shows at the edges and
  in a pocket bottom-left (Files is kept clear of the screen's left edge).
- **`MONTAGE[].at` is now CSS px of the work area** (was fractions), and
  `rectOf` refuses a window that leaves the work area (it would be clamped or
  cut by the shelf). `film.ts` reads the number of `opened-<i>` marks, so the
  beats (0.5 s → 0.13 s) re-spread over 8 windows with no code change.
- `desktop` re-recorded alone (it writes nothing; no seed). Recording ran at
  ~0.8 s per frame (~28 min a take); four takes (each window checked from
  its `opened-<i>` frame: `/tmp/film9/take4/`).
- **v9**: `~/Downloads/showcase/equin-v9.mp4`, 117.80 s (desktop
  104.77 → 113.60 s, the montage now ~2 s for 8 beats), 1920×1080 @ 60, 6
  pages, 602 s. Stills of the ending, 4 per second:
  `/tmp/film9/v9/s-*.jpg` (sheet `/tmp/film9/v9/sheet.jpg`); the settled
  montage `/tmp/film9/montage-final.jpg`.
- **Known app warts seen at any size** (not the window's): Sonata's card
  meta clips its date ("3h ag…") even at full width; a Chord song title can
  still ellipsize if long enough.

## Tenth pass (2026-11-05): composed like a photograph, a title that mirrors the end

Feedback on v9 (five points), and the Principles' new lines: photographic
composition, natural window proportions, one open surface at a time, the
title mirroring the end card.

- **Home's window (the pull-back's target)** was 1280 × 760 on a 1920-wide
  desktop — two thirds of the screen, nearly centred. Its content had to be
  the film's own screen (1280 × 720) for the pull-back to start on the very
  frame it leaves. Now it is 1000 × 600 of content (+ the 40 px titlebar:
  1000 × 640, 1.56), at (176, 124): about half the screen, up and left of centre,
  its centre near the left third, the wallpaper's light open on its right.
  The seam holds because Home's gallery is **centred and top-anchored** (its
  seven columns are 872 px wide; checked at 1280 × 720 and 1000 × 600 — the
  same layout, cropped). The first take used 960 × 580: there the grid
  (872 px plus its padding) reflows to six columns, and Circle and New app
  drop to a third row below the window's edge, so the window no longer
  showed the gallery the film left. Hence 1000: the `home-frame` mark is now where the full-screen
  gallery lies on the desktop (centred on the window's content, from its
  top, 1280 × 720 — overflowing the window), so the film draws the
  prototype's last frame there, the camera starts zoomed onto it (the
  identical frame), and as it pulls back the frame fades, only the parts
  outside the window changing (black → titlebar and wallpaper). The end runs
  it backwards: the camera pushes into the same view and the full-screen
  gallery fades back in over the window's surroundings (`backProto`).
- **Montage proportions**: every window landscape near 16:10 — Pages
  1040 × 650, Sonata 1080 × 676, Places 1140 × 712, Files 880 × 550, Tap
  Tap Party 720 × 450, Circle 880 × 550 (landscape now: its sidebar beside
  the conversation; v9's 480 × 720 phone column was a strip), Agent Manager
  1120 × 700; Chord 990 × 670 (1.48: one column must stay under its 1000 px
  container breakpoint, and reach down to its piano). Each checked alone at
  its content size in the browser.
- **The montage's composition**, previewed as stills before any take: the
  desktop's window store is sessionStorage (`s:desktop.windows:…` +
  `s:apps-core.tabs:…`), so writing every window's box there on the
  composition's `/desktop` at 1920 × 1080 and reloading shows the settled
  layout in seconds (three iterations). Final: the cluster keeps wallpaper on
  every side, Pages and Files peek on the left, Sonata and Tap Tap Party
  above, Places below, the light Circle bottom-left as a counterweight, the
  Agent Manager last and on top with its centre on the right third.
  Order changed to Pages, Sonata, Places, Files, Chord, Tap Tap Party,
  Circle, Agent Manager.
- **One open surface at a time** (Pages): after Agent page is chosen, the
  page-kind menu is dismissed (Escape, held until its "Agents may write
  anywhere on it." is gone — `holdUntilGone`) before the Wish opens.
  Verified on the take's frames.
- **Files pauses**: the hold after Files opens 0.8 + 0.8 s → 0.6 (places'
  end, the app's opening) + 0.25 s (sonata's start); after the score opens
  1.6 → 0.9 s.
- **Opening title** (`outro.ts` `titleCard`): "A self-evolving personal OS"
  on the site background, the end card's typography (Inter 700, -0.045em,
  the site's fg; 72 px so the phrase fits, vs the end card's 132 px word)
  and the same reveal — one `growingLine` now draws both: "A
  self-evolving" fades and rises in, then "personal OS" grows out of it
  while the line recentres (as ".ai" grows out of "equin."). Up from black,
  held ~1.3 s, the words blur out the way they came (a first try faded card
  and words together — the title then sat over Home's grid, muddled), then
  the card fades into the session: `INTRO` = 3.5 s, everything after shifts.
- **Recording**: reseeded (the stand-in account name moved to
  `infra/claude-cli/accounts/display-name`), every segment re-recorded. The
  first full run failed in `places` at its Pick UI: from the bar's opening
  on, ~5 s of identical frames — no picker outline, no popover — then
  "the Wish editor did not appear" (one frame's settle took 6 s on the
  re-run too; the host was loaded). Picking by hand on the same page worked,
  and `--only places` re-recorded cleanly (nothing had been written:
  the take failed before its Wish). Not understood; if it recurs, read the
  failed take's `places.timing.json` and the picker's state.
- **The pull-back's seam, first render (v10)**: the full-screen gallery now
  overflows the window, and it faded over 0.35 → 1.0 s while the camera
  was already pulling back — its edges showed as a dim rectangle shrinking
  over the wallpaper (stills at 107.5 s). Now it fades over 0.15 → 0.7 s
  (gone as the eased pull-back has only begun), and at the end it fades in
  only in the push-in's last 0.4 s, its edges already at the screen's. A
  feathered mask was rejected: it would show the window's titlebar at the
  first frame, which must be the prototype's last one exactly. Re-rendered
  as v11 (v10 kept, as every version).
- **Renders**: `~/Downloads/showcase/equin-v10.mp4` (119.93 s; the seam
  artifact above) and `~/Downloads/showcase/equin-v11.mp4` (the fix).
  Sections: title 0–3.5, pages 3.5–25.4, places 25.4–45.1, files
  45.1–52.1, sonata 52.1–70.7, create 70.7–79.8, prototype 79.8–106.9,
  desktop 106.9–115.7, end 115.1–119.9. Stills: `/tmp/film10/v10/`,
  `/tmp/film10/fix/`; the montage's settled frames `/tmp/film10/desk2/`.
- **Still off** (not this pass's): the health dot went critical once in the
  prototype take ("Main is not running its machine watcher", 6.31 s — main
  restarting); Files opens with the hand resting on the sidebar's Trash and
  its path bar reads `Home › .equin › cache › promo-film › Piano`
  (left as is, per the user); the Places photo grid's two-step opening
  (another agent's).

## Eleventh pass (2026-11-06): a fuller accumulation, a title that grows its claim

Feedback on v11: the user likes the montage's fast accumulation — add apps
(Deploy on a real-looking site, Prototypes on two prototypes) and give it a
shape: a few readable beats, then accelerating past counting, then a hard
stop on the focal window. The title becomes "A personal OS", then
"self-evolving" grows into its place, in the website homepage's accent.

- **Deploy's site, seeded like main's.** Its Overview's Traffic, Top pages,
  Top sources and Messages read the deployed box over SSH
  (`apps/deploy/host-query`), which a demo has none of. Now a fixture server
  can be a **stand-in box**: `deploy_host_stand_ins` (host-query's table,
  written by `markServerBoxIsThisInstance`) makes `hostOnlyQueryOverSsh`
  ask THIS instance's own host-only routes through its gateway
  (`namespaceUrl(runtimeNamespace())`, the one proxy hop `hostOnly`
  accepts) instead of curling the box over SSH — same routes, same parsing.
  The deploy fixture (`apps/deploy/fixtures`) then writes the data those
  routes read into the instance itself, through each owner's writer:
  visits through collect's `recordCollect` (back-dated, chronological — the
  real visitor identity, visits and hits), messages through intake's
  `insertReceivedSiteMessage`, the composition's secret through approvals'
  `setAndApproveDeploySecret` (no "RESEND_API_KEY new" banner). Runs carry
  REAL commits of main (the story reads `git rev-list --first-parent`, the
  running one ~64 behind), their subjects stamped from git as the ledger
  does, so Running, "64 commits behind", "main is 64 commits ahead",
  "Deploy 64 commits" and the Deployments list read like main's site.
  `publishWrittenRuns` (deployments) puts the fixture's runs into the live
  view the boot builds — without it the site read "Not deployed" until a
  restart.
- **Opening a window at a route.** Deploy is a developer app the launcher
  does not list to this user, and a prototype is a route inside Prototypes:
  a `MONTAGE` entry with a `route` opens a NEW window from the launcher
  (Shift+Enter) and routes it the way a link does — the URL changes
  (`pushState` + `popstate` with a `{}` entry) and the tab set reconciles
  the focused window's tab to the app owning it, in place. The site id is
  read off the seeded Deploy overview in the pre-roll.
- **Sizes, checked alone**: Deploy 1200 × 750 (two columns — Traffic beside
  Messages and Deployments — from ~1130 px; at 1060 it is one column, the
  cards stacked); Bridge Trainer 1200 × 780 (a prototype is laid out for a
  laptop screen: its frame ~1160 × 560 under the viewer's chrome keeps the
  table, bidding box and score card; its hand and coach are cut even at
  1280 × 800 — the prototype's own); Bundled Mail 1120 × 700.
- **Eleven windows**: Pages, Sonata, Places, Bridge Trainer, Files, Deploy,
  Chord, Bundled Mail, Tap Tap Party, Circle, Agent Manager — previewed as
  one still through the window store first (`/tmp/film11/preview-*.png`).
  More windows leave less wallpaper: it stays at the top-left, the right
  edge and the bottom-left pocket.
- **The accumulation's shape** (`montageIntervals`, film.ts), in sixteenths
  of the track's beat (172.2 bpm: 87 ms): 8 8 8 (three readable beats of
  0.70 s), then ×0.7 each — 6 4 3 2 1 1 1 — then the Agent Manager held a
  bar (16, 1.39 s) before Home comes back.
- **Title** (`outro.ts`): one `growingLine({ before, grown, after })` now
  draws both cards — the end card grows ".ai" after "equin.", the title
  grows "self-evolving" between "A" and "personal OS" (the line recentring
  by layout), painted with the homepage's `.website-hero-accent`: a 90°
  gradient from the azure (`--primary`) to the cyan (`--chart-1`) through
  the glyphs, the space after it left out. "A personal OS" is read alone
  ~0.55 s; the grown words wait 0.3 s after their box starts opening
  (`revealKeys`' `wordsDelay`: a first try slid them in at once, and
  mid-growth they showed clipped against "personal"), then the phrase holds
  ~1 s; `INTRO` 3.5 → 4.0 s. Stills: `/tmp/film11/title/`,
  `/tmp/film11/title2/`.
- **Reseeded**, so every segment was recorded again.

### Eleventh pass — how it went (2026-11-06)

- Built (`./equin build --composition promo-film`, migration
  `add_deploy_host_stand_ins`) and reseeded; the Deploy site checked in the
  browser: Live, Running `ee3ce25 fix(type-che…)`, 64 commits behind, the
  ahead strip, "Deploy 64 commits", Traffic (58 visitors ↑152 %, chart vs
  previous), three messages, Deployments titled by commit subjects, no
  secrets banner. (The Messages tab shows an unread badge "2"; main's
  shows none.)
- Recorded after the reseed: `pages`, `places`, `sonata` (files+sonata),
  `prototype` — all OK (`/tmp/film11-record.log`). The full run's
  `desktop` was killed at the background task's 2 h ceiling (the host was
  at load 80–130: 0.8–3 s per frame).
- `desktop` alone then failed twice on "screenshot: Timeout 30000ms" at
  ~14–15 s of the take — both times while the Bridge Trainer window
  (montage window 3) was on screen, the host at load 60–130
  (`/tmp/film11-desk-fail1.log`, `/tmp/film11-desk-fail2.log`). A third
  take runs detached (`nohup`, so no task ceiling) into
  `/tmp/film11-desk.log`; it recorded cleanly once the load fell to ~10–20
  (48.57 s, 2914 frames, 1.1 s per frame). Each window checked from its
  `opened-<i>` frame: `/tmp/film11/opened/`.
- **v12**: `~/Downloads/showcase/equin-v12.mp4`, 123.22 s, 1920×1080 @ 60
  (594 s on 6 pages). Sections: title 0–4.0, pages 4.0–25.9, places
  25.9–45.6, files 45.6–52.6, sonata 52.6–71.2, create 71.2–80.3, prototype
  80.3–107.4, desktop 107.4–119.0, end 118.4–123.2. Sheet of the ending
  (8 fps): `/tmp/film11/v12/sheet.jpg`; the title `/tmp/film11/v12/title-sheet.jpg`.
- Main moved on while recording: the site read "64 commits behind" at the
  seed and "96" in the take (the count is live against `refs/heads/main`).

## Twelfth pass (2026-11-06): nobody's name, a stand-in home, a quieter machine

Feedback on v12 and the v11 defect review (`/tmp/film-review/REPORT.md`): no
personal name on screen — neither the user's nor an invented one ("Alex
Martin"); no machine noise (the health dot flickering while main restarts, the
Mac's volume and disk); Files at `Home › Music › Piano`; and the film-side
defects of the review. Then the title: "self-evolving" came too late after
"A personal OS" and the phrase was held too long before the session.

- **Rebase.** Onto origin/main (61 commits: blocks easing in on a page —
  9539fd0ea0 —, newly shown tiles and sections fading in, Files keeping its
  listing while a preview opens, no sync fs on a backend's JS thread, …) with
  `--autostash`; eight files conflicted on re-applying the stash and were
  merged keeping both sides (the Files start-folder config with Home's new
  `;open` param, the composition's `hosts` with its negatives, the seed's
  piece reads made async for the blocking-fs lint, `cover` and `expanded` on a
  page fixture, both motion descriptions). The branch's migration was
  regenerated against the new tip (`--reset-migration`).
- **One name setting** (`infra/host-account`'s `profile-name` config, Settings
  → Profile): `displayName` (empty = the account's name) and `showName` (off =
  nobody in particular). `useProfileName()` folds it with the OS account into
  `named | anonymous`; the Pages workspace reads "<first name>'s pages" or "My
  pages" (its tile the initial or the pages glyph), and the Claude accounts are
  served under "Claude", "Claude 2", … while the name is off. The stand-in
  name config (`claude-cli/accounts/display-name`) is gone — folded into it.
  The seed turns the name off; its git commits are authored by "equin".
- **Health dot**: the Machine watcher row (`debug/sentinel/health-row`) and the
  Connection row (`infra/health/connection-row`) became leaf plugins, so the
  promo-film composition negates them as it negates gateway-drift — nothing
  else leaves with them.
- **Stand-in home** (`infra/host-account`'s `home-folder` config): the folder
  every app shows and opens as Home, and the server's `~`; the seed points it
  at `promoFilmWorkspaceDir/home` (`Music/Piano`, `Downloads`, `Documents`) and
  Files' start folder at `~/Music/Piano`. Under a stand-in, Files' Places name
  no checkout, volume or Trash and show no storage meter. A conversation's file
  chip outside its worktree reads `<folder>/<name>` (the full path on hover).
- **Film side**: menus closed by a click on their own trigger (the page-kind
  pill, the prototype's options), never Escape; the slider dragged on a
  `steady` profile (`Recorder.move/drag` `profile`: short ramps, an even speed
  between); Pick UI — the camera pulls back while the hand still rests on the
  button, then the 0.75 s gesture (a 1.1 s one outlasted the action bar's leave grace and lost the pick); the Circle glow starts the frame after
  the tile appears; `scrollAlong`'s cap may be a function — held at 100 px/s
  (under the ~115 px/s the list grows) while the agent writes, raised to 340
  once the map is written; the photo grid held 0.6 s; a launcher switch
  carries the hand on to its next target (`viaLauncher(…, then)`), the travel
  to the launcher timed by distance; the Files disclosure is one gesture onto
  the row's Expand control.
- **Title** (`outro.ts`): one tempo for both cards (`revealKeys`: the first
  part in 0.6 s, the growth 0.8 s after it starts); "self-evolving" starts
  growing on the beat nearest 0.95 s, the phrase is held ~0.35 s, its words
  leave on a beat, and the card fades into the session (`INTRO` 2.3 s) while
  they are still leaving — cut on motion. The end card's ".ai" grows on the
  same tempo.

### Twelfth pass — how it went (2026-11-06)

- Builds: `./equin build --composition promo-film` and `./equin build` both
  deployed after the merge fixes (a page fixture's `expanded` read through the
  sibling, the deploy fixture's country lookup and the seed's prototype read
  made async, the claude-accounts loader awaiting the now-async read).
  Checked live before recording: the Pages workspace reads "My pages" (the
  pages glyph in its tile), the Agent Manager's account footer "Claude",
  Files `Home › Music › Piano` with Home and Downloads only (App data stays:
  an equin place, not the machine's), the health dot green.
- Recorder fixes found while recording: `scrollAlong`'s braking step is now
  never under 1 CSS px while some is left (at a gentler accel it fell under a
  device pixel at dpr 1.5, Chromium rounded the `scrollBy` away and the
  follow stopped 2 px short forever); `stop({ maxSeconds: 8 })` for the
  map. The Pick UI travel stays 0.75 s: a 1.1 s travel outlasted the action
  bar's leave grace and the pick was lost (the Wish popover never opened).
- A seed once answered HTTP 500 (load ~46); the retry seeded cleanly. Cause
  not traced (the promo-film backend's server log did not hold it).
- Recorded after the final seed: `pages`, `places`, `sonata`, `prototype`
  (`/tmp/film13-record.log`), then `desktop` alone (`/tmp/film13-desk.log`).
  The recorder reverts the run's agent writes at its end (place-cards,
  Sonata's section layout, hidden apps).
- The desktop take first failed in the virtual clock: something on screen
  now runs a scroll/view-driven animation, and setting a progress-based
  animation's `currentTime` in ms throws. `page/clock.ts` now steps only
  document-timeline animations.
- **v13**: `~/Downloads/showcase/equin-v13.mp4`, 123.85 s, 1920×1080 @ 60
  (608 s on 6 pages). Sections: title 0–2.30, pages 2.30–24.97, places
  24.97–45.34, files 45.34–51.59, sonata 51.59–70.99, create 70.99–79.94,
  prototype 79.94–108.04, desktop 108.04–119.65, end 119.05–123.85.
- **Review** (`/tmp/film-review-v13/REPORT.md`, the page's method): clean —
  no personal name or real path, the health dot green throughout, no
  "Macintosh HD" / disk text / `.equin` path, the page-kind pill and the
  prototype options chip leave no ring or tooltip, the Circle glow starts
  with the tile, no camera move during either pick, the Files hand one
  gesture, the title hands over to the session without a dead hold. Still
  off:
  - the Pages scroll is one movement (no stop-start) but its speed steps
    (1.5 → 7.5 px/frame in 25–50 % jumps, a duplicate frame every ~20
    frames at the plateau): the cap is reached and left block by block —
    a smoother profile (critically damped toward a lookahead goal) is next;
  - the slider still steps (a 3,3,3,6 px pattern, dead stops between the
    three sweeps; the phones fill ~20 % of the frame);
  - after Home → Pages (f209) and Sonata → Agent Manager (f4647) the hand
    still crosses a sidebar row for ~0.25 s as the app cuts in (app: the
    launcher has no opening transition);
  - Pick UI in Sonata outlines 6 elements in 0.6 s (the travel cannot be
    slower than the action bar's leave grace — an app fix: the picker
    should survive the bar closing);
  - fast cursor flicks remain at 75.8, 84, 102.5 and 104.3 s;
  - app-side one-frame snaps (Places list/detail/grid, the Files preview,
    the prototype's Light / Phone / slider modes), as before;
  - "Maya Okafor" and friends are the Circle prototype's own made-up
    contacts (its content, shared with main) — not the user's identity.

## Thirteenth pass (2026-11-08): prototypes as apps, new apps first, the user's own page

Feedback on v13 (`~/Downloads/showcase/equin-v13.mp4`):

- **Montage — a prototype reads as the app it mocks.** Bridge Trainer and
  Bundled Mail showed the Prototypes viewer's frame. Prototypes already has
  the proper mode: the present page (`apps/prototypes/present`,
  `present/<id>/live/responsive`) — one frame alone, laid out at the window's
  own size, its chrome only on hover. A prototype montage entry now routes
  its new Prototypes window there (`presented(id)` in `segments.ts`). App
  side, the present pane is now titled by the prototype's own `<title>`
  (`usePrototypeTitle`, moved into `canvas/web/internal/use-prototype-title.ts`
  and exported by canvas's barrel, the canvas pane's own title), so the
  window's title bar reads "Bridge Trainer", not "Prototypes" — and a
  present page opened in a browser tab is named the same way.
- **Two more prototypes**: Family Recipes (`proto-1794092194-mfppco`: photo
  recipe cards, a weekly shopping list) and Jukebox
  (`proto-1792801597-cohp0r`: bookmarked songs as a music app).
- **New apps first.** Thirteen windows: Deploy, Tap Tap Party, Bundled Mail,
  Bridge Trainer, Family Recipes, Jukebox, Chord (never seen in the session),
  then Pages, Places, Files, Sonata, Circle, then the Agent Manager last and
  on top (unchanged at 690,200 1120×700). The three readable beats land on
  Deploy, Tap Tap Party and Mail on an almost empty desktop.
  `montageIntervals(13)`: 8 8 8 6 4 3 2 1 1 1 1 1 16 sixteenths.
- **Layout preview tool**: `e2e/montage-preview.ts --composition promo-film
  --out <dir>` lays the montage out in real time (the desktop take's own
  pre-roll and window opener, shared: `deskSetup`, `openMontageWindow`) and
  saves `opened-<i>.png` after each window — ~2 min instead of a take.
  Stills: `/tmp/film14/montage/`.
- **Pages — the Agent page switch closes its menu with Escape** (main no
  longer leaves a focus ring after Escape). Checked on the take: the pill
  reads "Agent page" in its resting tint (the blue a non-ordinary kind
  wears), no ring, from the frame after Escape on (`/tmp/film14/esc/`).
- **Prototypes scene, new order**: a second frame first (the add-frame
  button's box read before the gesture, no hardcoded point), its variant
  (Light), Phone, then This window (the desktop ratio, mark
  `desktop-size`), and the slider there.
- **The user's page** (seed `story/pages.ts`, `film-state.ts`): no "Time
  for…" prose. One sentence ("Looking for a real upright to replace the
  digital one."), three bullets (budget, try four or five, slow and loud),
  then "Shops to try": each shop a to-do "<shop>: <a line about it>" with
  its place already under it (Pianos Beaumarchais, Paul Beuscher ticked;
  Steinway & Sons not). The agent now only ADDS — Pianos International,
  Pianos Daudé, Nebout & Hamm in the same form, each with its place — then
  the map. The Wish is "Add more piano shops to this page".
- **No personal name in the story**: the teacher's page is "Lessons" (no
  "Ms. Laurent"), the TODO, 1:1s, Journal and Gift ideas pages and the
  "Shared shopping list" task name nobody. Left as they are: composers,
  performers and authors (works' credits), and the prototypes' own made-up
  people (Circle's contacts, Family Recipes' "Grandma Rose · Dad · Mum ·
  Aunt Léa · Tom" filter chips, Mail's senders) — the prototypes' content,
  shared with main.

### Thirteenth pass — how it went (2026-11-08)

- Rebased; the branch's migration regenerated (`--reset-migration
  --migration-name add_deploy_host_stand_ins`). The plain build's checks
  failed only on `paths:no-hardcoded-paths` in
  `conversations/…/jsonl-viewer/plugins/file-path/web/components/shown-path.test.ts`
  — another agent's file, edited concurrently — so the promo-film
  composition was built with `--skip-checks`.
- Seeded, then recorded `pages` (21.8 s), `sonata` + `prototype` (34.3 s),
  `desktop` — `places` not re-recorded (unchanged, and its join with the
  new `pages` ending is the same Places route).
  The `desktop` take: 58.3 s, 3499 frames (load 8–11). Every window checked
  on its `opened-<i>` frame (`/tmp/film14/opened/`): the prototypes fill
  their windows as apps, titled "Inbox — Bundled Mail", "Bridge Trainer",
  "Family Recipes", "Bookmark Jukebox"; no present chrome shows (the hand
  never hovers a presented frame); the Agent Manager lands last, on top.
- Checked on the frames: the Buying a piano page as seeded (sentence,
  bullets, three shops with places; `/tmp/film14/pages/`), the agent's three
  shops and the map written live, the map whole in view at the end; the
  prototype flow (`/tmp/film14/proto/`: two frames → Light → Phone → This
  window 1280×720 → the swipe).
- Not done: no render (the user renders); the scroll's speed profile and
  the slider were not re-measured (unchanged code). Remaining names on
  screen that are not the story's: the Deploy site's message senders
  (`marta.lindqvist@example.com`, …, the deploy fixture), the prototypes'
  people (Circle, Family Recipes, Mail).
