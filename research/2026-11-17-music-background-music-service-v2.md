# Background music service — v2

Supersedes `2026-11-17-music-background-music-service.md` after review: the rules follow how operating systems treat
audio, and Sonata's background playback is a follow-up refactor (player instances that outlive the page) instead of a
second hidden player.

## Context

Isle's ambience stops when the user switches app: in a maximized tab the app rail swaps the tab's app, so Isle's subtree
and the AudioContext it owns unmount. Approved prototype: `proto-1794888084-l0ekld` (button = `bars`).

## Rules (from OS precedent)

| Precedent | Rule here |
|---|---|
| macOS / Windows: apps mix; minimize / focus never pause | **Desktop mode**: an Isle window counts as shown while it is open (minimized included); nothing pauses on focus. |
| iOS: an app's audio stops when it leaves the screen unless it declares background audio | **Maximized mode**: when the source's app leaves the screen (rail switch, other tab), it pauses unless *Keep playing across apps* (config, **on** by default — the user's call after review) is on. |
| iOS ambient category / Android audio focus: real music interrupts ambient | **Foreground music** (a Sonata song starting) pauses the service's music when that music is not shown. |
| One audio focus per device | **Browser tabs**: service music, or foreground music, starting in one browser tab pauses the service's music in every other. |
| Now Playing (Control Center) | The **music button** shows and controls the service's music — in this tab, or mirrored from the tab playing it. |

Entering Isle while something else plays in the background (another tab): Isle's auto-play gives way; its chip / `M`
takes over. Volume is per device.

## Plugins

- **`plugins/music/plugins/background`** (core / web / server)
  - `core`: `backgroundMusicConfig` (`acrossApps`, bool, default false); `protocol.ts` — the pure reducer over page state
    (`current: { sourceId, playing } | null`, shown counts per source, remote mirror) and events (play, pause, stop,
    shown/hidden, foreground interrupt, remote claim/state/command, holder gone); the cross-tab message schema.
  - `web`: `BackgroundMusic.Source` slot — `{ id, app (AppDef), kind label, useTitle, component: headless player
    ({ playing, gain }) }`; `Core.Root` host mounting the current source's player (and every source's, idle, while the
    popover is open — warm-up, so the click only resumes audio); hooks `useMusicSource(id, { shown })`,
    `useForegroundMusic(active)`, `useBackgroundMusic()`; the cross-tab link (BroadcastChannel
    `equin.background-music` + a per-tab Web Lock for holder liveness); the `ActionBar.Item` music button and popover.
  - `server`: registers the config.
- **`music/ambient`**: `useAmbient` → `createAmbientHost()` + `useAmbientHost(host)` — one page-lived, ref-counted
  engine (context built suspended on first retain, closed on last release), plus `setGain`.
- **`isle/world-view`**: module-level Isle ambient host; `IsleMusicPlayer` (mood from config + time of day) contributed
  as the Isle source; `isle-view.tsx` drives the service instead of owning audio.
- **`sonata/audio/engine`**: a `SonataSession.Effect` calling `useForegroundMusic(isPlaying)`.

## Follow-up

Sonata as a background source, without a gap: split `SonataPlayerScope` into a page-level playback instance (cursor,
document, session, engine — kept alive while playing) and a view that attaches to it.

## Verification

- bun: protocol reducer (maximized leave with toggle off / on, desktop never pauses, foreground interrupt only of hidden
  music, remote claim pauses, mirror ordering, holder gone).
- vitest: popover states.
- Manual on the build: Isle → switch app (toggle off: stops; on: continues); Sonata song pauses background Isle; a
  second browser tab's play pauses the first, and the first's popover shows and pauses it.
