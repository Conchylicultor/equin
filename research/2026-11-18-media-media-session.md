# Media session: equin's music in Chrome's media controls

## Context

Chrome's global media controls (the toolbar's media hub, and through it macOS
Now Playing and the media keys) list a page only while an `<audio>`/`<video>`
element plays in it. Every piece of equin music is synthesized with Web Audio
(Sonata's engine, Isle's ambience through the background music service), so
none of it shows up there — only the tab's speaker icon. Real media elements
(the file explorer's media player) already appear.

Goal: one primitive that puts Web Audio music into the browser's media session,
used by the background music service and by Sonata.

## Design

### `media/media-session` (new plugin, web only)

```ts
useMediaSession(claim: MediaSessionClaim | null): void

interface MediaSessionClaim {
  title: string; artist?: string; album?: string;
  artwork?: readonly { asset: AssetPath; sizes: string; type: string }[];
  playing: boolean;
  position?: { duration: number; position: number }; // seconds, at rate 1
  actions: { play; pause; stop?; seekto?(seconds); seekbackward?(offset); seekforward?(offset) };
}
```

- **One owner per page.** The browser has one `navigator.mediaSession` per
  page; a page-global registry holds every mounted claim and the owner is the
  claim that most recently *started playing*. A claim that never played (a
  song loaded paused) never owns the session. When the owner unmounts, the
  previous one takes it back; with none, metadata / handlers / state clear.
- **Keep-alive element.** While an owner exists, a detached `<audio>` loops a
  generated near-silent 16-bit WAV (≥ 5 s: Chrome ignores shorter media as
  sound effects), playing / paused with the owner. That element is what makes
  Chrome open a session; the metadata and handlers say what it is. With no
  owner its src is dropped so the session goes away. A `play()` refused by the
  autoplay policy (`NotAllowedError`) is retried on the next user gesture.
- Artwork is an `AssetPath`, resolved with `useAssetSrcs` (absent where the
  transport cannot serve it).
- Handlers are registered for every action the owner offers and cleared for
  the rest; they call the owner's latest action.

### Background music service

`BackgroundMusicRoot` claims for the current local source: title from its
probe, artist = the app's name, artwork = the app icon PNG
(`getAppIconPng` / `appIconFile`), play → `resume`, pause → `pause`, stop →
`stop`. A source declaring `ownsMediaSession` (Sonata) is skipped — it claims
itself, with more to say.

### Sonata (`apps/sonata/plugins/now-playing`, new)

A `Sonata.PlaybackEffect` (follows the song, also when it plays on in the
background): title = the song's, artist "Sonata", app icon artwork, position =
cursor seconds over the tempo-scaled score (`buildTempoIndex`, `scoreEndBeat`)
refreshed on every timeline change and play/pause, actions play / pause(stop) /
seekto / seekbackward / seekforward through `useSession()`. Sonata's
`BackgroundMusic.Source` declares `ownsMediaSession: true`.

## Out of scope (follow-ups)

- Sonata songs in a file preview (mini player): no app-level effect there.
- Titles for the media player's real elements (already listed by Chrome).
- Routing real audio through the element (Chrome's volume would act on it).

## Verification

- `./equin check` + `./equin build`.
- Headless browser: start Isle / a Sonata song, read `navigator.mediaSession`
  (metadata, playbackState) and the keep-alive element's state via
  `browser_javascript`; invoke handlers by pausing from the music button and
  confirming `playbackState` follows.
- Manual: open the build in Chrome, play — the media hub lists it with title,
  play/pause and (Sonata) a scrubber.
