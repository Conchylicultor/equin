# Sonata: keyboard transport for every shown player (MIDI preview gets Space / ←→)

## Context

The file explorer's MIDI preview (`sonata/sources/midi/file-preview`) mounts its
own `SonataPlayerScope` but can only be played with the mouse. Sonata's keyboard
transport lives in `sonata/controls` as two **app-only** `Sonata.Effect`s:

- `TransportShortcuts` — Space / ↑ / ↓ via `useSurfaceShortcuts` (focus-scoped
  per surface), gated on `useSonataApp().currentSongId != null`.
- `SeekHoldController` — ←/→ tap-to-jump / hold-to-scrub, a raw window listener
  that gates itself on `getFocusedSurfaceId()` and the same `currentSongId`.

`Sonata.Effect` only mounts inside the Sonata app's layout, and `currentSongId`
is app state, so neither ever reaches a player mounted elsewhere.

What `currentSongId` really stands for is **"a player is on screen"** (the
Sonata surface is one player scope wrapping both library and player; the
library's now-playing bar must stay key-inert). Both hosts express that the same
way already: they render `<PlayerDisplay>` (Sonata's `SonataPlayerSurface` in
`library/web/panes.tsx`, and the preview). So the gate belongs to the **player**,
not the app.

A second, latent problem becomes real once arrows reach the file explorer: the
`ShortcutManager` (and `SeekHoldController`) ignore `event.defaultPrevented`.
The file tree's `use-tree-keyboard` handles ↑↓←→ and calls `preventDefault`;
data-table / data-card / icons-view rows handle Space the same way. Today a
global shortcut on the same key fires *as well*. With ←/→ seek in the preview,
arrowing through the tree would also scrub the song.

## Decisions

- **Which keys go to every player:** Space (play/pause) and ←/→ (seek bar /
  hold-scrub). Both act on things every player shows (play toggle, scrubber).
- **Stay app-only:** ↑/↓ tempo (the tempo control/readout exists only in
  Sonata's transport bar — in the preview it would be an invisible state
  change), and loop `L` / `[` / `]` (its toggle is a Sonata pane action).
  Unchanged, still gated on `currentSongId`.
- **Scoping:** cross-window / cross-preview isolation stays what it is —
  surface-scoped (`useSurfaceShortcuts`, `getFocusedSurfaceId`) with the
  handler closing over *this* player's session. Text fields already win via
  `targetClaimsKey`. New: **an element that already handled the key owns it**
  (`defaultPrevented` → shortcuts yield).
- **Once per player, not per display:** the effects mount once per player scope
  while ≥1 `PlayerDisplay` is shown — never twice (two raw seek listeners on one
  session would double-seek).
- Two players inside ONE surface is not a case any host produces today (the
  file pane is a single leaf; the Sonata surface is one scope). Not handled;
  noted in the player CLAUDE.md as the place a focus-within tie-break would go.

## Design

### 1. `player`: a "while shown" effect slot

`plugins/apps/plugins/sonata/plugins/player/web/`

- `slots.ts` — add `SonataPlayer.Effect: defineMountSlot({ docLabel })`:
  headless per-player effects that run **while the player is shown** (a
  `PlayerDisplay` is mounted). Contributors may read `useSession()`, the cursor
  hooks and `usePlayerView()` — never Sonata app state.
- `view.tsx` — `PlayerViewProvider` gains a shown-count: `useState(0)` plus a
  stable `useMarkShown()` (internal hook, not on the barrel) that increments on
  mount / decrements on unmount. Expose `shown: boolean` on `PlayerView`.
- `components/parts.tsx` — `PlayerDisplay` calls the mark-shown hook.
- `scope.tsx` — inside `PlayerViewProvider`, render a small `PlayerShownEffects`
  that mounts `<SonataPlayer.Effect.Mount />` iff `usePlayerView().shown`.

This is the highest rung: any host that shows a player gets the keyboard
transport, and a host that shows none (the library with its now-playing bar)
cannot get it — there is no gate to forget.

### 2. `controls`: move Space and ←/→ onto the player

`plugins/apps/plugins/sonata/plugins/controls/web/`

- `components/transport-shortcuts.tsx` → split:
  - `PlayPauseShortcut` — `useSurfaceShortcuts([{ id: "sonata.play-pause",
    keys: "space", … handler: togglePlay }])`, no `currentSongId` gate.
    Contributed as `SonataPlayer.Effect({ id: "play-pause" })`.
  - `TempoShortcuts` — ↑/↓ exactly as today (still `currentSongId`-gated),
    stays `Sonata.Effect({ id: "tempo-shortcuts" })`.
- `seek-hold-controller.tsx` — drop `useSonataApp` / `hasSongRef`; add
  `if (e.defaultPrevented) return;` before claiming the key. Contributed as
  `SonataPlayer.Effect({ id: "seek-hold" })`.
- `index.ts` — update contributions + description. `controls` imports
  `player/web` (no cycle: player imports session/document/score only).

### 3. `primitives/shortcuts`: a handled key is owned

`plugins/primitives/plugins/shortcuts/web/internal/shortcut-manager.tsx` —
`if (e.defaultPrevented) return;` at the top of `handleKeyDown`. The window
listener runs after React's root-delegated handlers, so a row / tree / editor
that consumed the key has already marked it. Before landing: `git grep` keydown
handlers that `preventDefault` a key some global shortcut also binds (modifier
combos especially — e.g. editors and Cmd+Z/Cmd+K) and confirm yielding is the
intended outcome there (the undo shortcut already yields to text fields by
`when`). Update the plugin CLAUDE.md prose and the `ShortcutDescriptor` doc.

### 4. Docs

- `controls/CLAUDE.md` — rewrite the keyboard-transport section (player-scoped
  Space/←→, app-scoped ↑/↓).
- `player/CLAUDE.md` — the `Effect` slot and the shown rule.
- `session/web/slots.ts` + `shell/web/slots.ts` comments ("App-only effects
  (shortcuts…)") and `SessionValue.togglePlay` doc — point at `SonataPlayer.Effect`.
- `file-preview` description: mention Space / ←→.

## Verification

- Unit (jsdom, `player/web/__tests__/`): a `SonataPlayerScope` with a test
  `SonataPlayer.Effect` contribution mounts it once with one or two
  `PlayerDisplay`s, and not at all with none (unmount → unmounts).
- Unit (`shortcuts/web/__tests__/`): a keydown whose target handler called
  `preventDefault` does not fire a matching shortcut; an unhandled one does.
- `./equin test plugins/apps/plugins/sonata plugins/primitives/plugins/shortcuts`
- `./equin build`, then a new e2e
  `file-preview/e2e/keyboard-verify.ts` (same `--file` convention as
  `open-in-sonata-verify.ts`): open the preview → it auto-plays; Space → paused
  (play toggle label flips); Space → playing; pause, ArrowRight → scrubber
  `aria-valuenow` advances one bar; focus the file tree, ArrowDown → tree
  selection moves and the scrubber does not.
- Regression in Sonata (screenshot.ts / manual): on a song, Space / ←→ / ↑↓ / L
  work; on the library (now-playing bar), Space and arrows do nothing; two
  Sonata windows still toggle only the focused one.
