# Keyboard Party in the browser demo

Track: "apps running in the browser, on fake or local data" (wiki
block-d04c6c0d-56fd-49f2-88f4-914e059cc83b). Task: "Keyboard Party is not in the
browser demo" (requested by the user, 2026-11-06).

## Context

`/demo` runs the `agent-manager-demo` composition (real server code in a
SharedWorker on PGlite, from a build-time snapshot). Agent Manager, Home, Pages,
Prototypes, Sonata and Desktop are in it; Keyboard Party ("Tap Tap Party") is
not, so the launcher inside the embed does not offer it.

## What Keyboard Party needs (audit)

- **Server**: `party/server` only registers `partyConfig` with config_v2 —
  portable, so it joins the worker graph by itself once the app is in the
  composition. The worker serves the committed config (product defaults); the
  settings popover's writes go through config_v2's real `set-field` handler.
  No user data, so nothing to seed: the product defaults *are* the demo's
  settings, as on a fresh install.
- **Assets**: none loaded over the network. Pictures are emoji text
  (`core/keys.ts`), every sound is synthesized with WebAudio
  (`web/internal/audio.ts`), speech is the browser's `speechSynthesis`. Nothing
  to route through the transport; nothing can reach the page's server.
- **Keys**: taken by the stage's own React `onKeyDown` (focused on mount and on
  every tap, `preventDefault` on each key) — no window listener, no shortcut
  registry, so it works the same inside an embed and a desktop window as long as
  the stage holds focus.
- **Lock**: `stage.requestFullscreen()` + Keyboard Lock on the stage element — a
  browser API on an element of the page, works in the embed as anywhere. Not
  machine-bound; no `needsMachine` needed.

## Change

1. `plugins/plugin-meta/plugins/composition/core/config.ts`, `agent-manager-demo`:
   add `"apps.keyboard-party.**"` (with a comment saying why it needs nothing
   else). The coverage guard (`./equin build`) confirms every read/config it
   uses is served.
2. Docs: the workspace demo's `CLAUDE.md` (composition paragraph, app list).
3. New e2e `plugins/apps/plugins/demo/e2e/keyboard-party-in-demo.ts`, modelled on
   `sonata-in-demo.ts`: launcher → Tap Tap Party; the stage takes focus; press
   letters, a digit, Space, an arrow — each adds a bead to the trail and
   effects to the layer; a WebAudio tap counts sounds started; an init-script tap
   on `speechSynthesis.speak` records the spoken word ("A, Apple"); the page
   URL stays `/demo`; open the party settings and change Scene (a write to the
   worker's config, the stage's `data-scene` follows); open it as a Desktop
   window, take it Full screen, and press keys in both; the party's Lock
   (browser fullscreen + Keyboard Lock) works inside the embed too; no `/api`
   leak, no page socket, no errors.

## Found on the way: a brandless app is a dead end in an embed

The first e2e run opened Keyboard Party and could not leave it. Its layout is a
bespoke full-surface stage that draws no app brand; on main a visitor leaves by
the rail or tab bar (docked) or the floating launcher (solo). An `AppEmbed`
draws no rail or tab bar and did not mount `Apps.Overlay`, so the floating
launcher never appeared either. Two fixes:

1. **Structural (every brandless app in an embed).** `AppEmbed` mounts
   `Apps.Overlay` inside its tab state, as the page's layout does. The floating
   launcher's rule becomes "no app switcher frames this surface": solo, or a
   contained tab set in a mode that does not draw its own frame (docked). It
   reads its own tab set's mode and placement registry (not the page-global
   mode), renders nothing until that registry is known, and measures its
   reveal radius from its containing block's corner (a fixed zero-size marker
   — the embed's box inside an embed, the viewport on the page).
2. **Keyboard Party's corner draws the brand** (`<AppShellBrand form="icon"/>`
   beside Lock and Settings, the documented pattern for an app with bespoke
   chrome). The floating launcher, once revealed, covered the Lock button
   (also on main in solo); with the brand drawn the floating one stands down.
   Hidden with the rest of the corner while locked.

## Verification

Done 2026-11-06: `./equin build` (coverage guard green, no exemption);
screenshots looked at; all eight demo e2e scripts pass (`persistence` failed once
at host load ~80 and passed on rerun); boot test, composition tests and
app-embed tests (new: overlays render inside, over the embed's tab set) pass.

Planned: `./equin build`; screenshots of the stage in the embed (look at them); run
snapshot, persistence, no-leak (visits every launcher app — now includes
Keyboard Party), app-switch, desktop-in-demo, prototypes-in-demo,
sonata-in-demo and the new script; `./equin test` on the workspace demo's boot
test.
