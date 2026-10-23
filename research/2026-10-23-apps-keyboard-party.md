# Keyboard Party — a keyboard toy app for a child

## Context

The user wants an app that entertains their child: every keyboard key answers
with its own animation and sound. Approved prototype: `proto-1792778741-ozou7w`
("Keyboard Party"). The real app reproduces it inside Singularity at
`/keyboard-party`.

## What it shows

One full-surface stage (no sidebar, no panes):

- **Letters** — a big outlined letter in the letter's hue, one of six entrances
  (pop, spin, bounce, wobble, zoom, jelly) picked by its index, a picture
  beside it (A 🍎, B 🐻 …), the word under it, a confetti burst. A pentatonic
  note on one of four synthesized instruments, then speech ("A! Apple").
- **Digits** — that many pictures count up with rising dings; the number spoken.
- **Space** fireworks · **Enter** rainbow · **Arrows** a flier crossing that way
  with a slide whistle · **Backspace/Delete/Esc** everything pops like bubbles ·
  **modifiers/Tab/CapsLock** a googly blob boings · **anything else** confetti +
  drum keyed off the key.
- A bead trail of recent keys along the bottom; a tap drops a random letter.
- A small corner cluster for the parent: **Settings** (the config fields) and
  **Full screen**, which also takes the Keyboard Lock (`navigator.keyboard.lock()`,
  Chromium) so Esc and most system keys reach the toy instead of the browser.

## Data

No DB. One config descriptor (config_v2), registered on web + server, so it is in
Settings → Config and in the in-app popover:

| field | type | default |
|---|---|---|
| scene | enum night / sunny / paper | night |
| motion | enum lively / calm | lively |
| voice | enum word / letter / off | word |
| trail | bool | true |

All reads are cosmetic (`useConfig`, defaults acceptable during the boot window).

## Plugins

```
plugins/apps/plugins/keyboard-party/          empty namespace
  plugins/shell/   core/app.ts defineApp(id "keyboard-party", basePath "/keyboard-party")
                   web: Apps.App({ app, icon, component: KeyboardPartyLayout })
  plugins/party/   core: classifyKey (key → effect kind, pure, tested), letter words,
                         count pictures, pentatonic notes, config descriptor
                   web:  PartyStage (React shell over an imperative effects layer),
                         audio synth (Web Audio), speech, effects (WAAPI on DOM nodes),
                         corner controls (ControlPanelPopover + FieldRenderer, FullscreenButton)
                   server: ConfigV2.Register
```

Reused: `defineApp` (primitives/pane), `Apps.App` / `appIcon` + `symbol`,
`defineConfig` + `enumField` / `boolField`, `useConfig` / `useSetConfig`,
`FieldRenderer`, `ControlPanelPopover`, `FullscreenButton` (fullscreen),
`IconButton`.

## Keys vs. the shortcut registry

The window-level `ShortcutManager` skips any `defaultPrevented` event. The stage
is a focused element with a React `onKeyDown` that `preventDefault`s every key, so
while the toy has focus no app shortcut fires — no window listener (banned by
`shortcuts/no-window-key-listener`). It focuses itself on mount and on pointerdown.
`e.repeat` is ignored so a held key plays once.

Effects are imperative (WAAPI on short-lived nodes in a ref'd layer, capped node
count) — React re-rendering per particle would be wasteful; the layer is the
equivalent of a canvas.

## Verification

- `./singularity test plugins/apps/plugins/keyboard-party` — classifyKey.
- `./singularity build`, then drive `/keyboard-party` with the `browser_*` tools:
  press letters / digits / space / arrows, screenshot, check console clean.
- Add `<meta name="mocks" content="app:/keyboard-party">` to the prototype.
