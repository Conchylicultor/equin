# film

## The parallel render (`e2e/internal/run.ts`, `encode.ts`, `core/`)

A render splits its frames among several headless pages working at once.
`renderAt(t)` is a pure function of film time, and frame `i` of a render of
`[from, to)` always shows `frameTime(from, i, fps)` = `from + i / fps`,
whichever page renders it. So any split gives the same pictures.

- **Chunks**: `splitFrames(frames, workers, minFrames)` (`core/`) cuts
  `[0, frames)` into contiguous ranges whose sizes differ by at most one
  frame. A range is never shorter than 2 s of film, because a page's start-up
  would cost more than the range saves. `--workers <n>` sets how many pages
  render at once. The default is `defaultWorkers(cores)` = cores / 3, since one
  worker keeps about three cores busy (a Chromium renderer and a
  multithreaded x264). `--workers 1` is the serial render: one page, one
  encoder, frames plus audio in one ffmpeg.
- **Encode**: each chunk is its own x264 encode, video only, with exactly the
  serial encoder's settings (`videoCodecArgs`). Each chunk opens on an IDR
  frame, and no frame references across a chunk boundary (closed GOPs by
  construction). `concatArgs` joins the chunks with the concat demuxer
  (`-c:v copy`, so the bytes are untouched) and encodes the audio once over
  the whole film, from the one mixed WAV. Verified: with lossless x264, the
  serial and the parallel render decode to identical `framemd5` for video
  (pixels and timestamps) and for audio. With the lossy settings, a chunk's
  rate control cannot see past its own end, so the bitstreams differ (same
  quality, not the same bytes).
- **Never a partial film, never an overwrite**: both paths write to a hidden
  `.<name>.partial-<pid>.mp4` beside the output, then `link()` it to the
  output name, which refuses a name that exists. The partial is removed
  either way. The chunks live in a temp dir (`film-chunks-*`) that is always
  removed. The first chunk to fail stops the others (their encoders are
  killed, and their loops end at the next frame), and its error is what the
  render throws.
- **The web version** (`FilmScript.web`): after a full (non-preview)
  render, `<out>-web.mp4` is transcoded from the finished film
  (`webEncodeArgs`: H.264 high, CRF 28 slow, peaks capped at 2.5 Mbit/s,
  AAC 128k, faststart) — partial file, then `link()`, refused up front when
  it exists, like the film itself.
- The SFX bus is synthesized in the first page and the sound mixed once,
  before any frame renders. `filmServer` bundles the renderer once for every
  page.

## The recorder (`e2e/internal/record.ts`)

`record(page, opts, script)` drives a real page on a virtual clock
(`page/clock.ts`) and captures it frame-exact; see the file's header.

- **An element target is re-aimed every frame.** `move` / `click` / `drag` to a
  Locator re-read its box on each frame of the travel and of the click's dwell,
  and press where it is then. The page keeps moving while the hand travels (a
  popover sliding into place as the bar it hangs from collapses); a point
  aimed once lands where the element was — outside a popover that has since
  moved on, which dismisses it (the bug that ate the promo film's Wish prompt:
  its keys then went to the app underneath). A `{x, y}` target is a fixed
  screen point.
- **An element target not on the page yet is waited for on the page's
  clock**: frame by frame (up to 5 s), since a popover still opening can only
  appear while the clock runs — a plain Playwright wait holds it still and
  times out.
- **No scroll ever overscrolls**: a `wheel` `dy` past the scroller's end
  throws (Chromium's elastic overscroll would bounce the page back), and so
  does a **`scrollTo`** whose position the scroller cannot reach on any frame.
  `scrollTo` is the camera: an absolute eased move (default `inOutQuad`, at
  rest at both ends) of the target's scroller, landing exactly on its goal.
  Its goal comes from **`settledRect`**: where an element will be once every
  running animation has finished (each scrubbed to its end for one
  synchronous layout read, then put back — the virtual clock makes the
  final layout readable before it is drawn). **`watchScroll`** logs the
  scroller's position on every frame (`input.scroll`), to check a move frame
  by frame and that nothing else scrolled the page.
- **A hand, not a dart.** `move`'s default `ease` is the minimum-jerk
  reach (peak speed 1.875× the average; inOutCubic's 3× read as a dart);
  `steady` is an even speed between short ramps (content dragged along);
  `performed` is an animator's gesture — slow in, slow out
  `PERFORMED_OVERSHOOT` past the target, a gentle settle back, a slight
  sideways waver that vanishes at both ends. A path through `via` points
  may not turn more than `MAX_VIA_TURN_DEG` at one (it throws: that is two
  gestures). `Recorder.cursor` is where the pointer is.
- **An animation's play state is the app's; its time is the clock's.**
  `page/clock.ts` wraps `Animation.prototype.pause` / `play`: an animation
  the app pauses stands where it left it, and one it plays (again) is driven
  on virtual time from the playhead `play()` left it on — re-paused for the
  clock at once, never left on the real timeline while the recorder waits
  (it would play out between two frames: the pane morph, which pauses its
  view-transition animations until Places has drawn, cut instead of grew).
  The clock advances each driven playhead by the virtual time stepped, so an
  app's seek (`currentTime =`) is kept too. A **`startTime =`** is a play
  dated by the app (the fold primitive dates its tween from
  `performance.now()`): the clock drives it from playhead (now − startTime) ×
  rate, and `document.timeline.currentTime` reads virtual time — natively the
  setter ran it on the real timeline, already past its end at the next
  frame (every fold snapped open and shut in the promo film).
- **The page's calendar can be pinned**: `installRecorderClock(context, {
  date })` makes the context's pages read `date` (epoch ms) and run on from
  it, across reloads (anchored at install, so time never goes back) — a
  recording shows the day it is set on, not the day it was made.
- **Slow motion at capture**: `Recorder.clockRate(rate, { over })` makes each
  frame step the page clock by `rate`/fps (ramped over `over` s), and every
  duration the script gives (holds, moves, scrolls, a click's dwell) is page
  time, so the page, the camera and the hand slow together, still one fresh
  frame per 1/fps — never a repeated frame. Logged as `input.rate`.
- **Every frame's real time per phase** (settle, clock step, screenshot) is
  written to `<dir>/<name>.timing.json` (`frames`, and `failedFrame` — the
  phases of the frame in flight when a recording fails); a phase running over
  5 s is logged while it runs and when it ends, so a stall reads as one, with
  its duration. The closing line prints screenshot p50 / p99 / max.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Film engine: a composition of layers over captured app stills, animated by keyframe tracks and a 3D camera, rendered frame by frame in a headless page (renderAt(t) is a pure function of film time), mixed with a music bed and synthesized SFX, encoded to MP4.
- Deps:
  - Uses:
    - `infra/deps.defineDep`
    - `infra/deps.ensureDepViaCli`
    - `infra/deps.Ready`
    - `infra/deps/download.download`
    - `infra/deps/download.downloadedFile`
  - Exports (values):
    - `mouseSoundFiles`
    - `mouseSounds`
    - `resolveMouseSounds`
- Cross-plugin:
  - Imported by:
    - `apps/prototypes/canvas`
    - `apps/website/promo-film`
- Core:
  - Exports (types): `FrameRange`
  - Exports (values):
    - `defaultWorkers`
    - `frameCount`
    - `frameTime`
    - `splitFrames`

<!-- AUTOGENERATED:END -->
