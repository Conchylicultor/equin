# youtube

An embedded YouTube player the app can control — the repo's first. Nothing
domain-specific: the chord trainer is its first user, and it turns the
callbacks into its own playback reports. `core/` holds the video id itself:
`VideoIdSchema` (a bare 11-character id) and `youtubeVideoId(raw)` (the id
behind a bare id, share link or watch URL, or `null`). The `audio-fetch`
sub-plugin downloads a video's audio on the server; `song-videos` answers
"which videos are this song?". Design:
[`research/2026-09-18-apps-chord-trainer-app.md`](../../../../research/2026-09-18-apps-chord-trainer-app.md)
("The YouTube player").

## Using it

```tsx
const player = useYouTubePlayer();              // stable controller for this component
const state = useYouTubePlayerState(player);    // loading | ready { videoId, playing, started, duration } | error { code }

<div className="aspect-video w-48">             {/* the size is yours; the iframe fills it */}
  <YouTubePlayer
    controller={player}
    videoId="dQw4w9WgXcQ"
    loop={{ start: 42.1, end: 51.7 }}           // or null: play straight through
    autoplay={hasInteracted}                     // start each new video by itself?
    onReady={(duration) => …}                   // once per video, when its length is known
    onPlaying={() => …}                         // once per video, the first time it plays
    onError={(code) => …}                       // YouTube refused the video
  />
</div>

<button disabled={state.kind !== "ready"} onClick={() => (player.isPlaying ? player.pause() : player.play())} />

// Only this element re-renders every frame:
function Playhead() { const t = useYouTubePlayhead(player, true); … }
```

The controller: `play()`, `pause()`, `isPlaying`, `isAdvancing` (strictly
playing), `playRange(start, end)`, `seek(seconds)`, `getCurrentTime()`,
`getDuration()` (`null` until known), `getPlaybackRate()` and
`setPlaybackRate(rate) → Promise<rate taken>`. Every method throws
`YouTubePlayerNotReadyError` before the player is ready, so gate controls on
`useYouTubePlayerState(player).kind === "ready"`.

- **Seek never plays.** `seekTo` on a cued (or unstarted, without autoplay)
  video starts it — the API's documented behaviour — so the controller re-cues
  at the time (`cueVideoById`) instead. "Not started" is the controller's own
  record (no PLAYING since the load), not `getPlayerState()`, which lags the
  load: a `seekTo` sent before the iframe reports the cue hits a player with no
  video and gets error 2.
- **One cue at a time.** The iframe applies a cue whenever it lands, undoing
  a command sent meanwhile (a play right after a cue lands the video cued, not
  playing). So while a cue is in flight (sent, not yet reported), a seek or
  play of the unstarted video is HELD, and sent in order when the cue is
  reported: a re-cue at the new time first (if it moved), then `playVideo`.
  A player that becomes ready mid-song (seek + play at once) relies on this.
- **A video asked to play is starting.** From a `play()` until a `pause()` a
  seek is a plain `seekTo` (a re-cue would stop it), and an UNSTARTED the
  iframe reports on the way (cued → buffering → unstarted → playing) still
  counts as `isPlaying` — not a stop a follower would act on.
- **No rates before the first play.** `getAvailablePlaybackRates()` answers
  `undefined` until the video has played; a `setPlaybackRate` then is HELD and
  sent (snapped) when the video first reaches PLAYING, its promise resolving
  as usual once the player reports the rate. Asking for the rate it already
  plays at resolves at once.
- **Rates.** A video takes only the rates it lists. `setPlaybackRate` snaps the
  request (`snapPlaybackRate`, core: the nearest supported rate, but at least
  one step off the current one toward the request, so a nudge or a slow drag
  moves) and resolves when `onPlaybackRateChange` reports it. Requests before
  that share one promise, resolving to where the last lands; a rate the player
  never takes never resolves — the caller keeps showing the rate it plays.

## The media clock

`createMediaClock(controller).position()` — for something slaved to the video
(Sonata's synth): the playhead through a linear model (`createSmoothClockModel` from
`packages/smooth-clock`, pure) refitted on each reading and slewed toward it at ≤ 5 % of the rate,
snapping past 150 ms (a seek) or on a rate change; `null` unless strictly
playing, and every stop forgets the fit. Pull-based: one read per call.
`loadYouTubeIframeApi()` is exported for a caller that wants the raw `YT`
namespace; the player uses it itself.

## The loop

- `play()` with a loop starts from the loop's start when the playhead is
  outside it.
- While the video plays there is **one `setTimeout`**, set for the media time
  left until the loop's end divided by the playback rate. When it fires, the
  player seeks back to the start if the video really reached the end (within
  50 ms), and otherwise sets a new timer. The timer is cleared on every state
  change (pause, buffering, a seek, the end) and set again when the video
  plays. There is no polling.
- `playRange(start, end)` plays that stretch once. At its end the player goes
  back to the loop's start and keeps looping; with no loop it pauses. A `seek`
  cancels the pass.
- Changing `loop` on the same video moves the loop without reloading; if the
  video is playing outside the new loop, it jumps to its start. A new `videoId`
  is loaded in the same player (`loadVideoById` when `autoplay`, else
  `cueVideoById`), starting at the loop's start.
- A background tab throttles timers to once a second, so a loop there can
  overshoot its end by up to a second.

## The playhead

`useYouTubePlayhead(controller, active)` reads the time once per animation
frame, only while the video plays and `active` is true — animation, not change
detection. The IFrame API's `getCurrentTime()` is the last time the iframe
posted, which can trail by a few hundred milliseconds, so while the video
advances the controller extrapolates from the last reported change by wall time
(at most 0.5 s ahead). The loop's end check uses the same time.

## The audio

`audio={{ volume, muted }}` (volume 0–100) holds the player at that level, on
the current video and every one loaded after — it is re-applied on each load,
so the level is the app's, not the video's. Muting does not pause: a muted
video keeps playing and keeping time, which is what lets something else follow
its playhead in its place (the chord trainer's piano plays a loop's chords this
way while the song is muted). Omit `audio` to leave the sound as YouTube has it.

## Player settings

`controls: 0` (the app owns play / pause / seek, and YouTube's bar would let
the viewer leave the loop; `<YouTubePlayer controls>` turns the bar on for a
video the viewer plays by hand — read at creation, so changing it re-creates
the player), `disablekb: 1` (the iframe's shortcuts would fight
the app's), `modestbranding: 1`, `playsinline: 1`, `rel: 0`, `iv_load_policy: 3`,
`fs: 0`, `origin: window.location.origin`. The iframe is 100 % × 100 % of the
element `<YouTubePlayer>` renders.

## Failure

A failure to load the IFrame API script is thrown during render, to the nearest
error boundary; the shared promise is cleared, so a remount tries again. A video
YouTube refuses is not a failure of the player: the state becomes
`error { code }` and `onError(code)` fires (2 bad parameter, 5 HTML5 error, 100
not found or private, 101 / 150 embedding refused — 150 also covers region
blocks and sign-in-required videos). Only 100, 101 and 150 are a verdict on the
video (`statusFromPlayerCode`); 2 is the caller's bug and 5 a player fault,
both `undecided`.

The `YT` types are declared locally (`web/internal/iframe-api.ts`), only the
calls the controller makes; `@types/youtube` is not a dependency.

## Server: embeddability and search

- **Embeddability** (`core`): `EmbedStatus` (`ok | gone | not-embeddable`),
  `statusFromOembedCode` and `statusFromPlayerCode` (an IFrame `onError` code)
  map a code to one, or `undecided`. `checkOembed(videoId)` (server) asks
  oEmbed — never the watch page, which draws a captcha after ~100 — with a 2 s
  timeout; no answer is `unreachable`, a 200 also names the video. The chord
  trainer keeps its own ledger of these answers (`apps/chord/video-availability`).
- **Search** (server): `searchYouTube(query, exec)` — yt-dlp's flat search, one
  results page, nothing downloaded (~2–3 s); a script with no `ExecContext`
  uses `searchYouTubeWith(ready)`. "<Artist> - Topic" art tracks show only as
  `artTrack` (the snippet starts "Provided to YouTube by"): the results page
  names their channel by the artist alone.
- **yt-dlp** is this plugin's `python/` uv project (`youtube_audio.fetch`,
  `youtube_audio.search`, shared `_common.py`), the `youtube-audio` dependency
  (`deps/`: `ytDlpDep`) — owned here, not by `audio-fetch`, because both the
  download and the search run it.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Embedded YouTube player the app controls: loadYouTubeIframeApi (the IFrame API, loaded once), <YouTubePlayer controller videoId loop autoplay audio onReady onPlaying onError onStateChange/> bound to a useYouTubePlayer() controller (without controls the iframe takes no pointer and its thumbnail covers it until it first plays, so none of YouTube's chrome shows, and a click opens the video on youtube.com at the playhead) (play, pause, isPlaying, isAdvancing, playRange for one pass then back to the loop, seek — re-cueing a video that has not started rather than starting it — getCurrentTime, getDuration, getPlaybackRate, setPlaybackRate resolving to the rate the video took), useYouTubePlayerState, useYouTubePlayhead (one read per animation frame while playing), and createMediaClock (a smoothed, slewed reading of the playhead for something slaved to it). Loops without polling: one timer to the loop's end, reset on every state change. Server-side YouTube: checkOembed(videoId) asks oEmbed whether a video plays in an embed (status code mapped by the core's statusFromOembedCode, plus the title and channel of a 200), and searchYouTube(query, exec) lists YouTube's results for a query (id, title, channel, duration, views, verified, art track) through yt-dlp's flat search, from the on-demand `youtube-audio` dependency this plugin owns.
- Web:
  - Uses:
    - `primitives/css/center.Center`
    - `primitives/css/layer.Layer`
    - `primitives/css/layer.layerClasses`
    - `primitives/css/line.Line`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.cn`
    - `primitives/hover-reveal.hoverRevealGroup`
    - `primitives/hover-reveal.hoverRevealTargetWithGroupFocus`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/link-gesture/new-tab.NewTabGlyph`
  - Exports (types):
    - `MediaClock`
    - `YouTubeAudio`
    - `YouTubePlaybackState`
    - `YouTubePlayerCallbacks`
    - `YouTubePlayerController`
    - `YouTubePlayerProps`
    - `YouTubePlayerState`
    - `YouTubeRange`
    - `YTNamespace`
    - `YTPlayer`
  - Exports (values):
    - `createMediaClock`
    - `loadYouTubeIframeApi`
    - `useYouTubePlayer`
    - `useYouTubePlayerState`
    - `useYouTubePlayhead`
    - `YouTubeIframeApiLoadError`
    - `YouTubePlayer`
    - `YouTubePlayerNotReadyError`
- Deps:
  - Uses:
    - `infra/deps.defineDep`
    - `infra/deps/python.pythonEnv`
  - Exports (values): `ytDlpDep`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --ring`
    - `ui/tokens/density --space-2xs`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/type-scale --font-weight-medium`
  - Imported by:
    - `apps/chord/trainer`
    - `apps/chord/video-availability`
    - `apps/sonata/recording`
    - `integrations/hooktheory`
    - `integrations/youtube/song-videos`
    - `integrations/youtube/song-videos/youtube-search`
- Server:
  - Exports (types):
    - `OembedCheck`
    - `SearchOptions`
    - `YouTubeSearchResult`
  - Exports (values):
    - `checkOembed`
    - `searchYouTube`
    - `searchYouTubeWith`
- Core:
  - Exports (types):
    - `CodeVerdict`
    - `EmbedStatus`
  - Exports (values):
    - `EmbedStatusSchema`
    - `snapPlaybackRate`
    - `statusFromOembedCode`
    - `statusFromPlayerCode`
    - `VideoIdSchema`
    - `youtubeThumbnailUrl`
    - `youtubeVideoId`
    - `youtubeWatchUrl`
- Sub-plugins:
  - **`audio-fetch`** — YouTube audio download: fetchYouTubeAudio(videoId, exec) returns one video's best audio stream as served (webm/opus or m4a, no ffmpeg), downloaded by yt-dlp — JavaScript challenges solved on bun…
  - **`song-videos`** — Which YouTube videos are this song? The SongVideos.Source contribution (a source's find(query, exec) → answered videos | unavailable) and findSongVideos(query, exec): every source asked at once…

<!-- AUTOGENERATED:END -->
