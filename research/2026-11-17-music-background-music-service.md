# Background music service

## Context

Music in Isle (generative ambience) and Sonata (song playback) stops when the user switches app: the app rail swaps the
focused in-page tab's app, so the previous app's subtree — and the AudioContext it owns — unmounts. The user wants a
background music service apps register into, controlled from a music button in the global action bar.

Approved prototype: `proto-1794888084-l0ekld` (button = `bars`). User decisions after review:

- "Keep playing across apps" toggle, **off by default** — off, leaving the app stops its music (today's behaviour). No
  first-time tip.
- Sources: **Isle and Sonata only**.
- **One player across browser tabs** — never two tabs playing at once.

## Design

The service owns *who is playing*; each source app owns *how it sounds*. Audio that must outlive an app's subtree is
played by a headless **player** the app contributes, mounted by the service at the page root (`Core.Root`, scope
`page`). The service never names Isle or Sonata (collection-consumer separation).

### Plugins

| Plugin | Contents |
|---|---|
| `plugins/music/plugins/background` (core/web/server) | `backgroundMusicConfig` (`acrossApps` bool, default false), pure protocol reducer, `BackgroundMusic.Source` slot, page-root host, hooks, cross-tab link |
| `plugins/music/plugins/background/plugins/button` (web) | `ActionBar.Item` music button + `ControlPanelPopover`, pixel-matched to the prototype |
| `plugins/apps/plugins/isle/plugins/music` (web) | page-lived Isle ambient host, `IsleMusicPlayer`, `useIsleMusic()`, Source contribution |
| `plugins/apps/plugins/sonata/plugins/background-music` (web) | `SonataBackgroundPlayer`, in-app `SonataMusicHost` (`Sonata.Effect`), Source contribution |

### Service API (`music/background`)

- `core/protocol.ts` — pure `step(state, event) → { state, effects }`: play/pause/stop/volume, host attach/detach
  (with a resume snapshot), focus change (owner app → other app), lock stolen, remote mirror/command, player
  ended/failed. All rules live here and are unit-tested.
- `BackgroundMusic.Source` render slot: `{ app: AppRef, kind, useOffer(): ResourceResult<Offer|null>, component:
  ComponentType<{ playing, gain, resume, onEnded, onFailed }> }`. `resume` is an opaque record the source parses.
- Hooks: `useBackgroundMusic()` (popover: current, remote?, volume, acrossApps, play/pause/stop/setVolume),
  `useMusicSource(id)` (an in-app control claiming/pausing its source), `useMusicHost(id, host|null)` (an in-app audio
  owner — Sonata — attaching its live transport; returns `{ gain, handback }`), `usePlayerSnapshot(getter)`.
- Rules:
  - One `current` per page; a new play pauses the previous source.
  - Toggle **off**: focus leaving the owner app pauses (kept as paused in the popover; Play resumes it there).
  - Toggle **on**: a host detaching while playing hands off to the source's background player at its snapshot.
  - A returning host takes back the live position (`handback`) and the player unmounts.
- Volume: service-owned slider 0..1, device-local (web-storage), `gain = volume²` passed to players and hosts.

### Isle

- `music/ambient`: add `setGain` (output gain node); replace `useAmbient` with `createAmbientHost()` — a ref-counted
  page-lived handle (context built suspended on first retain, closed on last release; `unlock`, `set({on, mood})`,
  `duck`, `sfx`, status subscribe). Isle is its only user.
- `isle/music`: module-level host; `IsleMusicPlayer` computes the mood itself (config + time of day, moved from
  world-view) so it keeps following the clock in the background; `useIsleMusic()` keeps the view's warm-up at mount.
- `isle-view.tsx`: `useAmbient` → `useIsleMusic()` + `useMusicSource("isle")`. Start / returning auto-plays as today;
  the chip and the `M` key claim/pause; duck and sfx unchanged. Toggle off ⇒ behaviour identical to today.
- Popover title: the current mood label.

### Sonata — handoff

The app session cannot be hoisted to the page root (five per-surface providers, per-surface isolation, 505 MB of
samples pinned). Instead:

- `SonataMusicHost` (`Sonata.Effect`): attaches the app transport with a snapshot `{ songId, beat, tempoScale }`;
  `isPlaying` ⇒ claim. Unmount carries the snapshot.
- `SonataBackgroundPlayer`: a headless `SonataPlayerScope` + `SongHydrator(songId)` → `loadDocument` →
  `requestSeekOnLoad(beat)` + `requestPlayOnLoad()` (the library's `BackgroundPlayProvider` pattern), volume through
  a new engine `useOutputTrim(gain)`.
- Takeback: back in Sonata, the host loads the same song at the player's live beat and plays; then the player unmounts.
- Offer "your last piece": the most recently played library song (playback-history).
- Sonata exports needed: `useOutputTrim` (engine; master = volume × trim), `SongHydrator` (library).
- Known cost: a ~1–3 s gap while the background session decodes samples; a brief ~1 GB peak on takeback. Sharing
  decoded samples (task-1794377773) removes both — a follow-up.

### One player across browser tabs

- Exclusive Web Lock `equin.background-music.player`, held while a page has a `current`. A local play requests it with
  `steal: true`; the previous holder's `AbortError` ⇒ it drops its `current` (only `AbortError` handled).
- BroadcastChannel `equin.background-music`: the holder broadcasts its state; `hello` on boot asks for it; ordered by
  claim stamp. A queued shared request on the lock detects a dead holder (push-based, no heartbeat).
- A non-player tab's popover shows the remote now-playing and drives it (play/pause/volume/stop as commands); clicking a
  source there plays locally (steal).
- `CrossTabLink` interface, real impl + in-memory fake pair in `web/testing/`.

### Button / popover

`ActionBar.Item({ id: "music" })` (added to `config/shell/action-bar/item.jsonc`). Note icon idle, 4-bar equalizer
while playing (reduced-motion aware). Popover: header + across-apps switch; now-playing card (`AppIconTile` art, title,
`<kind> · <App>` link via `useAppLink`, play/pause, volume, stop) or "Nothing playing"; "From your apps" rows. Theme
tokens instead of the prototype's hard-coded colours.

## Decisions (user, 2026-11-17)

- Sonata ships in v1 with the handoff gap; follow-up: shared decoded samples (task-1794377773).
- Entering Isle while another source plays in the background: Isle **gives way** (its auto-play does not claim; only the
  chip / `M` takes over).
- Volume is per device.
- Hidden-but-loaded Sonata tab with the toggle off: pending (explained to the user).

## Revision: the rule is "on screen", not "focused" (desktop mode)

Desktop mode shows several tabs at once as windows; the focused tab is just the window last clicked. "Focus left the
owner app" would pause Isle when you click a Mail window right beside it. So the service keys on **whether a surface
playing the source is on screen**, not on the focused app:

- New primitive `useSurfaceOnScreen()` in `apps-core/tabs` (the surface already computes `onScreen` per tab for
  residency: the focused tab in solo/docked; every non-minimized window in desktop mode) — published per tab.
- Hosts and in-app controls attach **per surface** (host key = surface tab id), each with its `onScreen`.
- Toggle **off**: a source plays only while at least one of its surfaces is on screen. Switching the tab to another
  app, hiding the tab, closing or **minimizing** the window ⇒ pause. Clicking between two visible windows ⇒ nothing.
- Toggle **on**: it keeps playing regardless; a Sonata surface that unmounts hands off to the background player.
- **One thing plays at a time** (page-wide, and browser-wide via the lock). A play in Sonata window B pauses Sonata
  window A (today both play together). Two Isle windows share one page-lived ambient, so they are one source.
- Isle's own `useSurfaceFocused` gate is dropped in favour of the service's rule (today Isle goes silent when you
  click another visible window).

## Risks

- Sonata providers/effects headless at the page root (recording driver needs a YouTube DOM host) — verify first; skip
  the recording driver in the background player if needed.
- Playing Isle from the popover with no Isle view mounted builds the AudioContext right after the click (short freeze).
- Behaviour change: with the toggle off, a hidden resident Sonata tab now pauses when focus leaves Sonata.

## Verification

- bun: `music/background/core/protocol.test.ts` (claims, focus rules, handoff/takeback, steal, mirror ordering, holder
  gone); Sonata resume parse.
- vitest: page-root host mounts/unmounts a fake player; cross-tab fake pair (tab B play ⇒ tab A drops); popover states;
  ambient host retain/release.
- Manual (`browser_*` on the build): Isle Start ⇒ equalizer; switch app with toggle off ⇒ paused, back ⇒ plays; toggle
  on ⇒ continues; Sonata song continues across a switch and is taken back; a second browser tab's play silences the
  first, and the first tab's popover pauses it remotely.
- `./equin check`, `./equin build`, `register_before_after` for the action bar.
