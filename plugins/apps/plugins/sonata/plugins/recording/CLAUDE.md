# recording

Plays the recording a score is timed on — `Score.meta.recording`, a YouTube
video whose seconds ARE the score's seconds at tempo scale 1 — and makes it the
transport's clock. Nothing here knows about alignment: whoever shows a song's
recording (today the UG alignment) declares it and renders a viewport onto it.
Design:
[`research/2026-10-07-apps-sonata-ug-alignment-video.md`](../../../../../../research/2026-10-07-apps-sonata-ug-alignment-video.md) (Part 1).

## The player is the session's, not the section's

The YouTube player lives with the playback session, so the video outlives
whatever shows it — a collapsed section, a display switch, the library:

- `RecordingProvider` (`SonataSession.Provider`) holds the store: the one
  controller, the claimed video, the **stage** — a plain element holding the
  iframe, never re-created — and the **parking spot**, a player-sized box fixed
  off screen on `<body>` (not hidden: a parked video keeps playing and posting
  its time). It also renders `RecordingPlayer` beside its children.
- `RecordingPlayer` (draws nothing in place) renders `<YouTubePlayer>` into
  the stage through a portal, registers the transport driver and mounts
  `SonataRecording.Refused`.
- `useShowRecording(videoId | null)` — whoever shows the song's recording
  declares it from an always-mounted effect (a section body unmounts when
  collapsed). The latest claim wins.
- `RecordingVideo()` is only a **viewport**: mounting moves the stage in,
  unmounting moves it back to the parking spot, both with `Element.moveBefore`
  — a state-preserving move, so the iframe neither reloads nor pauses. Moved
  back in a layout-effect cleanup, before React detaches the viewport, so the
  iframe is never out of the document. One viewport at a time. A browser
  without `moveBefore` leaves the stage parked (the video plays on unseen) and
  the viewport says so.
- `RecordingSwitch()` — the on/off switch (`playVideo`), for the header of the
  section showing it. Off: no player at all, the synth plays alone on the same
  timing. On: a new player, sought to the cursor and played if the transport
  plays.

## `RecordingVideo`

The video (16:9), then its volume row right below it — a mute button, a 0–100
slider and the level as a number. There is no sync-offset control in the card
(see the mix below). Two modes:

- **Synced** — the open score is timed on this video
  (`score.meta.recording.videoId === videoId`). YouTube's controls are off (the
  transport is the app's), and while the player is ready it registers a
  **transport driver** (`createVideoDriver`, `web/driver.ts`) with the session.
- **Not synced** — any other video (the song's chosen video before it has an
  alignment, or one that failed to align). It plays on its own with YouTube's
  controls and drives nothing; the synth keeps the score's own timing. A small
  "Not synced" badge (dot + label on a translucent dark pill) sits over the
  video's top-left corner, letting clicks through. Switching between the two re-creates the player (`controls` is fixed at
  creation).

The driver:

- `position()` — the controller's playhead through the YouTube media clock
  (`createMediaClock`: smoothed, slewing ≤ 5 % toward each iframe post, snapping
  past 150 ms), minus the sync offset; `null` unless the video is strictly
  playing.
- state — playing → `advancing`, buffering → `stalled`, otherwise ready →
  `paused`, a player error → `failed`.
- `seek` adds the sync offset back (never below 0); `setRate` is the
  controller's `setPlaybackRate`, which resolves to the rate YouTube took.

So while the player is ready the cursor, the synth (re-anchored on the driver,
drift-checked at ±40 ms), the metronome, the A–B loop (a seek back to A) and
the tempo (snapped to YouTube's rates) all follow the video, shown or not, and
a pause from the video stops the transport. Turned off (or not yet ready) the
driver unregisters, the session re-anchors its own clock where the cursor was,
and the synth plays on alone over the same aligned timing.

Whether the video plays at all (`playVideo`, the header switch) is its own
config, `sonata.recording-video`, one per app.

The **mix**: the synth's level is the audio engine's plain volume control in
the header. The video's sound (on/off, muted never paused — it keeps time), its
volume and the **sync offset** (ms the synth and the playhead trail the video's
reported time, −500…500, default 0; the iframe's sound comes out late by a
machine-dependent amount, set it by ear) are the `sonata.recording` config
(`shared/config.ts`, registered on web and server): one per app, not per song.
The card edits only the sound and volume; the sync offset is edited in
Settings → Config, and the driver keeps reading it live.

## Player errors and refusals (`SonataRecording.Refused`)

A player error is shown under the video either way, and a synced driver
reports `failed` (the transport stops). A non-refusal error offers **Reload
video**, which creates the player afresh (the store's `generation`). Only a REFUSAL — `statusFromPlayerCode`
decides `gone` (100) or `not-embeddable` (101 / 150) — is reported: it mounts
`SonataRecording.Refused` once for that video. Any other code (2, an invalid
parameter — our bug; 5, an HTML5 fault) says nothing about the video, so it is
shown and never reported. It is mounted by the headless player, so a
refusal is reported whether or not the video is on screen. A contribution reads the
refusal with `useMediaRefusal()` — `{ provider, videoId, status, code }` — and
reports it from a mount effect to whoever chose the video, so another can be
picked. The recording names no contributor; with none, the panel still shows
the refusal.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Sonata recording: the session's recording player — the YouTube video whoever shows a song's recording declares (useShowRecording), owned by the playback session so it outlives what shows it: RecordingVideo is only a viewport the playing iframe is moved into (Element.moveBefore, never reloaded) and out of, to an off-screen parking spot, so collapsing its section or switching the display neither stops nor reloads it. When the open score is timed on that video (Score.meta.recording) it is the session's transport driver while ready — the cursor, the synth and the A–B loop follow the video, its rate is the tempo; otherwise it plays on its own with YouTube's controls under a “Not synced” badge. RecordingSwitch turns the video off (the synth plays alone, same timing) and on. The video's on/off persists in the sonata.recording-video config; its sound, level and the sync offset (no control in the card; Settings → Config) in the sonata.recording config. Owns the SonataRecording.Refused seam for whoever picked a video YouTube refuses to embed. Server registration of the Sonata recording mix config and the video on/off config.
- Web:
  - Slots: `SonataRecording.Refused`
  - Slot contributors: `SonataRecording.Refused` ← `apps.sonata.sources.ultimate-guitar.alignment`
  - Contributes:
    - `ConfigV2.WebRegister` "sonata.recording"
    - `ConfigV2.WebRegister` "sonata.recording-video"
    - `SonataSession.Provider` → `RecordingProvider`
  - Uses: 23 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `integrations/youtube` ×5
    - `config_v2` ×3
    - `apps/sonata/session` ×2
    - `primitives/css/clip.Clip`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/pin.Pin`
    - `primitives/css/rigid.rigidClass`
    - `primitives/css/slider.Slider`
    - `primitives/css/spacing.Stack`
    - `primitives/css/switch.Switch`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit.Button`
    - `primitives/icon-button.IconButton`
    - `primitives/latest-ref.useLatestRef`
    - `primitives/slot-render.defineMountSlot`
  - Exports (types): `MediaRefusal`
  - Exports (values):
    - `RecordingSwitch`
    - `RecordingVideo`
    - `SonataRecording`
    - `useMediaRefusal`
    - `useShowRecording`
- Server:
  - Contributes:
    - `ConfigV2.Register` "sonata.recording"
    - `ConfigV2.Register` "sonata.recording-video"
  - Uses: `config_v2.ConfigV2`
- Cross-plugin:
  - Imported by: `apps/sonata/sources/ultimate-guitar/alignment`

<!-- AUTOGENERATED:END -->
