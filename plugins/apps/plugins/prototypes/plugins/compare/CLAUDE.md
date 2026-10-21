# compare

The prototype canvas's **Real app** frame: the real thing a prototype says it
mocks, live and interactive, beside the mock at the canvas's size. It is a
`FrameSource` contribution to the `canvas` plugin (id `REAL_APP_SOURCE`,
`"real-app"`, in `core/`; add label "Real app"), so it arrives through the
canvas's add rail (Compare with Real app) (and stays across a reload, since the canvas is remembered for the tab's session). The size, zoom,
side-by-side and swipe are the canvas's — this plugin paints no layout.

It owns two things and names no kind of counterpart:

1. **Reading the declaration.** A prototype names its counterpart in its own
   document, as `<meta name="mocks" content="<kind>:<ref>">`. The `files`
   plugin parses that on the wire (`parseMocks` → `none` / `malformed` /
   `declared { tag, ref }`), so this plugin never sees a raw string.
2. **Dispatching on the kind** (`RealAppSource`, `web/components/real-app-source.tsx`).
   `Counterpart.Kind` (`web/slots.tsx`) is a dispatch slot keyed on the tag. A
   kind is a child plugin under `plugins/` contributing `{ match: "<tag>",
   label, example, component }`. Shipped kinds: `exhibit` (one real component
   from the exhibit catalog, `plugin-meta/exhibits`, rendered inline in the app)
   and `route` / `app` (the running app at a path —
   the screen alone, or the whole app with its rail and tab bar; one plugin,
   two contributions). Another kind is a new folder here and no edit to this
   plugin.

## The contract: a kind resolves, the canvas renders

A kind contributes a **component whose only output is `children(resolution)`**
(`CounterpartKindProps` / `CounterpartResolution`, `web/types.ts`). It is a
real component — it may run hooks (the exhibit kind loads a catalog, the route
kind reads the app registry) and it mounts inside the dispatch middleware's
error boundary — but it paints no layout of its own, so the frame is always
the canvas's size.

The resolution has three arms, and every one is a state the frame renders:

- `loading` — the kind does not know yet. Never the "no counterpart" copy,
  which would be a claim about the user's file that reverses itself.
- `unresolved { title, detail }` — the kind understands the tag but cannot
  resolve the ref here (no such exhibit on this branch; no pane at that path).
- `found { title, subtitle?, badge?, href?, render(width, height) }` — how to
  paint it at the canvas's logical size, what the frame's tag says ("/agents ·
  App screen"), and, for a counterpart that is a page, the URL that opens it on
  its own (Present's new browser tab).

`RealAppSource` maps that onto the canvas's `FrameResolution` (the tag is
`badge ?? title` plus `subtitle`). The kind's `target` prop is everything after
the first colon; it is not named `ref` because that collides with React's
`RefAttributes` on a `ComponentType`.

## The four visible states

| State | Decided by | What the reader sees in the frame |
| --- | --- | --- |
| no tag | the parser | "does not say what it is a mockup of" + every declarable kind's example line |
| malformed | the parser (also a `problems[]` entry on the card and the pane's banner) | the raw line, the reason, the syntax, the known kinds |
| unknown kind | the dispatch fallback (`UnknownKind`, in `slots.tsx`) | "nothing in this worktree shows a `<tag>:` counterpart" + the known kinds |
| unresolvable ref | the kind itself | the kind's own sentence (exhibit: missing / ambiguous; route: no app / no pane) |

The example lines come from the registry (`useCounterpartKinds()`), never from
a hardcoded pair, so a new kind documents its own syntax by existing. The
fallback lives in `slots.tsx` rather than its own file because it reads the
registry it falls back from — a fallback file importing the slot while the slot
imports the fallback would be an import cycle.

The declaration is one-directional — the prototype names its counterpart.
Prototypes are host-global and outside git while kinds and their catalogs are
per-worktree, so the lookup can only ever happen at runtime, and "this worktree
has no such thing" is an ordinary answer, not a fault.

## Diffing the mock and the app from outside: `e2e/compare-diff.ts`

The canvas puts the mock and the real thing side by side for a person. The
`compare-diff` script does the same for an agent, and then subtracts one from
the other:

```bash
./singularity run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts \
  --name proto-1786877040-3k6f [--width 1440] [--options theme=launch,palette=azure] \
  [--out /tmp/mist] [--fail-above 5]
```

It opens the prototype's canvas on the deploy this checkout built, adds the
Real app frame (Compare with Real app), waits for it to resolve, sets the canvas to 100% through the size & zoom chip
(so a pixel of the mock is a pixel of the app), and photographs both frames at
the one canvas size. `--width` must be a size preset's width (the run refuses
and lists the presets otherwise); without it the canvas stays at the size the
prototype declares — `window` (the default) is photographed at Laptop, since
a headless run has no viewer's window — or, for a `responsive` prototype,
Responsive with the browser window sized until the frames come out at
Laptop's size. It writes
`<out>-mock.png`, `<out>-app.png`, `<out>-diff.png` and
`<out>-side-by-side.png`, logging the differing-pixel ratio and a per-cell
heatmap. `--fail-above <pct>` turns the ratio into a verdict; without it the
run is a transcript tool.

The mock is photographed at its authored defaults (frame A's picks are reset
first) unless `--options` names the variant. The values are judged against
the page's declarations by the same rule the server applies to a frame URL (an
undeclared name or value refuses the run), picked through frame A's own options
pill, and checked on the mock document's `<html data-*>` before the capture.
Frame A's picks are the shared record; the harness reverts what the run wrote.

The pixel diff is salient by construction — a surface one shade off passes
it — so colour is reported separately, with the colours named: the dominant
colours of each half and the ΔE to their counterparts (the background first),
the mean colour of each region, and the luminance profile across rows and
columns. That is `<out>-colors.png` and the "colour report" block in the
transcript; `--delta-e` sets the drift line (default 5).

**It drives the canvas, it does not re-implement it.** The script never reads
the `mocks` tag and names no kind. It finds the two frames through the
canvas's published DOM contract (`canvasFrameSelector` from `canvas/core`):
frame A of kind `prototype` is the mock, the frame whose kind is
`REAL_APP_SOURCE` is the app, and `data-canvas-frame-status` says when the app
frame has resolved (on `unresolved`, the frame's own text is printed as the
reason). An `e2e` script may import a plugin's `core` and `e2e` barrels but
never its `web`, which is why the source id lives in `core/`.

Both captures come out of the same Chromium at the same size, which is what
makes a pixel diff honest here — the pixel arithmetic itself is the harness's
`diffImages` (see `tooling/e2e-harness/CLAUDE.md`), not anything of this
plugin's.

Design: `research/2026-09-10-global-prototype-counterpart-kinds.md`, and the
canvas redesign `research/2026-09-23-apps-prototypes-frame-canvas.md`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The prototype canvas's "Real app" frame: the real app thing a prototype declares it mocks (<meta name="mocks" content="<kind>:<ref>">), resolved through the open Counterpart.Kind registry and contributed as a FrameSource, so the canvas shows it beside the prototype at the canvas's size. Each kind of counterpart (an exhibit from the exhibit catalog, the running app at a route) is a child plugin.
- Web:
  - Slots: `Counterpart.Kind`
  - Slot contributors:
    - `Counterpart.Kind` ← `apps.prototypes.compare.exhibit`
    - `Counterpart.Kind` ← `apps.prototypes.compare.route`
  - Contributes: `FrameSource` "Real app" → `RealAppSource`
  - Uses:
    - `apps/prototypes/canvas.FrameSource`
    - `primitives/css/badge.Badge`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/slot-render.defineDispatchSlot`
  - Exports (types):
    - `CounterpartKindMeta`
    - `CounterpartKindProps`
    - `CounterpartResolution`
  - Exports (values):
    - `Counterpart`
    - `useCounterpartKinds`
- Cross-plugin:
  - Imported by:
    - `apps/prototypes/compare/exhibit`
    - `apps/prototypes/compare/route`
- Core:
  - Exports (values):
    - `REAL_APP_LABEL`
    - `REAL_APP_SOURCE`
- Sub-plugins:
  - **`exhibit`** — The exhibit: counterpart kind for the prototype canvas's Real app frame: one real app component, looked up by id (exhibit:<id>) in the exhibit catalog (plugin-meta/exhibits — any plugin's exhibits/…
  - **`route`** — The route: and app: counterpart kinds for the prototype canvas's Real app frame: the running app itself, framed at an in-app path on this deploy's own origin — chromeless for route…

<!-- AUTOGENERATED:END -->
