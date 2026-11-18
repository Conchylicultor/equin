# Media session v2: every Sonata player claims it

Follows [v1](./2026-11-18-media-media-session.md).

## Context

v1 claimed the media session for a Sonata song from a `Sonata.PlaybackEffect`
— a slot only the Sonata app's player mounts — because the song's title was
read from the app (`useCurrentSong`, through `useSonataApp`). A song playing in
a file preview or a mini player has no app around it, so it never reached
Chrome's media controls.

## Design

The unit that plays a song is the playback session, and every Sonata player
(the app's instance, a file preview, the library's song peek) composes one
over a song document. So the claim belongs to the session, and the name to the
document:

- **`apps/sonata/now-playing` contributes a `SonataSession.Effect`** (mounted
  by `SonataPlayerScope`'s playback half, wherever it is) instead of a
  `Sonata.PlaybackEffect`. It still follows the app's song when it plays on in
  the background (that instance's playback mounts the same effects).
- **The song's name comes from its document identity.** `SongIdentity`'s
  `file` arm gains a required `name` (the file name — tsc makes every file
  loader give one); a `library` song's name is its live row title
  (`useLive(songLibrary, { id })`, so a rename follows).
- Several players at once are already arbitrated by `useMediaSession`: the one
  that most recently started playing owns the page's session.

The media primitive and the background-music service are unchanged.

## Verification

`./equin check`, `./equin build`; in the headless browser: a library song in
the app still claims (title, paused state); a MIDI file preview playing shows
the file name as `navigator.mediaSession.metadata.title`.
