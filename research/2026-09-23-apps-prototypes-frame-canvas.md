# Prototypes detail pane → a canvas of frames

## Context

The prototype detail pane has two tabs (Focus / Compare), and its settings are spread over
three places: the header, the Compare tab's second row (Against / Width / Zoom), and a
floating options pill. Over 14 turns the user iterated a replacement mockup,
`proto-1790120832-wtfo` ("Prototypes app — rethought"). This plan makes the real pane
match it.

What the user will see:

- **Header**: title, copy-id icon, Done checkbox icon, then on the right:
  `Side by side | Swipe` (only with exactly 2 frames), **+ Frame**, **+ Real app**.
- **Canvas** (the whole pane width, no stage tabs): a row of frames, centred,
  scrolling when they're bigger than the pane. Each frame has:
  - a coloured letter (A, B, C…) and a name. The name is the variant's first two
    values, plus every value where the frames differ.
  - its own `‹ v14 · latest ›` version stepper. The label opens the version list, and a
    past version shows **Make vN the latest**.
  - hover actions: **Keep only this frame** (with an Undo toast), **Duplicate**, a
    **Present** menu, and **Close**.
  - its own options pill, shown on hover at the bottom. Its rows have "who else uses
    this value" letters, a **link** button (same in every frame) and a **spread** button
    (one frame per value).
  - a right-edge drag handle. Dragging it resizes every frame and snaps to the presets.
- **Size & zoom chip** (bottom right, canvas-wide):
  - Size: Responsive / Phone / Tablet / Laptop / Desktop / Wide / Custom.
  - Zoom: Fit, or a 10–200% slider. The value box jumps to 100%.
  - A **Whole page** switch.
- **Present** (per frame): In this app tab (plus a new-app-tab icon), In this browser tab
  (plus a new-browser-tab icon), and Full screen (`F`). While presenting, hovering shows
  the frame's tag with its stepper, "i of n · ← →", Exit, the options pill, and the
  size chip. ←/→ flip through the frames.

Decisions the user made:

- **Frame A is shared.** The first prototype frame reads and writes the shared picks
  record, as today. Other frames hold local picks.
- **The URL holds the coarse layout.** `proto/<id>` opens one frame.
  `proto/<id>/compare` opens A beside the real app.
- **Delete the old UI outright.**

## Plugin shape

A new sibling plugin **`plugins/apps/plugins/prototypes/plugins/canvas`** owns the
detail pane. `gallery` shrinks back to the gallery list: its pane, the card Done
action, New prototype and the launch prompt. The detail pane is now mostly new code,
and its parts all serve one surface.

| Plugin | After |
|---|---|
| `gallery` | gallery pane + route, `PrototypeCardActions`, `DoneCardAction`, `useSetPrototypeDone` (exported for canvas's header toggle), new-prototype, CoverSwatch |
| `canvas` (new) | `prototypeDetailPane` (route `proto/:name/:layout?`, parent = gallery route), `PrototypeDetailProvider`, the canvas, frames, per-frame version stepper + version list, options pill, size & zoom chip, header add buttons, Done header toggle, swipe, keyboard |
| `compare` | ONLY the real-app frame source: `Counterpart.Kind` dispatch slot + `route`/`fixture`/`component` kinds + notices + `core/` half attrs. Delete `version` child plugin, `against.tsx`, `compare-stage`, `counterpart-stage`, `use-pair-room`, `fit-pair(+test)`, `scaled-box` |
| `present` | contributes a per-frame action (Present menu) into canvas; overlays/stage/new-tab page render a canvas frame |
| `copy-id` | import `prototypeDetailPane`/`usePrototypeDetail` from canvas |

Dependency direction: `canvas → gallery, files`; `compare → canvas`;
`present → canvas`; `copy-id → canvas`. That is a DAG.

## Canvas model (`canvas/web/internal/`)

```ts
type FrameId = number;
type CanvasFrame =
  | { id; kind: "prototype"; version: PrototypeVersion | null; picks: "shared" | StoredPicks }
  | { id; kind: "source"; source: string };  // a FrameSource contribution id
type CanvasSize = { kind: "responsive" } | { kind: "preset"; preset: PresetName } | { kind: "custom"; w: number; h: number };
type CanvasZoom = "fit" | number;             // 0.1–2
type CanvasState = { frames; selected: FrameId; size; zoom; wholePage: boolean;
                     layout: "side" | "swipe"; swipeAt: number; spread: string | null; linked: ReadonlySet<string> };
```

- Pure reducer `canvasReducer(state, action)` (in a `canvas-model.ts` with a
  `.test.ts`). Its actions are: add prototype frame (copies the last prototype frame's
  version and picks, with `"shared"` resolved to a snapshot), add source, remove,
  keep-only (returns the previous state for Undo), select, set version, set pick
  (linked options fan out to every prototype frame), toggle link, spread / unspread,
  size / zoom / wholePage / layout.
- **Frame A = the first `kind:"prototype"` frame.** It always has `picks: "shared"`.
  Its version is held on the provider, like today's `shownVersion`, so it keeps the
  existing "scoped by name, reset on prototype switch" behaviour. On remove or
  keep-only, if A is removed, the next prototype frame becomes A. Its snapshot picks
  are written to the shared record, so what's on screen doesn't change.
- **Pure helpers, unit-tested:**
  - `frameName(frame, frames, options)`: the first two declared options, plus every
    option on which the prototype frames differ.
  - `letterOf` / `colorOf`: color tokens from the theme, never raw hex.
  - `layoutFrames({ room, n, size, zoom, wholePage, pageHeights }) → { width, height, scale }`,
    following the mock's `layout()`:
    - Responsive: logical size = room / scale. At Fit, scale = 1, or fits the tallest
      page when Whole page is on.
    - Presets and Custom: the preset's width × height, scaled at Fit to
      `min(roomW/w, roomH/visibleH)`.
  - Presets: Phone 480×900, Tablet 768×1024, Laptop 1024×640, Desktop 1280×800,
    Wide 1600×900. Drag snaps within 28px.
- **URL**: `layout` param. It reads `compare` as "start as [A, real app]" and writes
  `compare` back whenever a source frame is on the canvas (else none), via
  `useSetParams` (same pane instance). The CLI's links and the mocks
  `route:/prototypes/proto/<id>/compare` keep working.

## Frame sources: the open seam compare fills (`canvas/web/slots.ts`)

```ts
FrameSource = defineSlot<{ id; addLabel: string /* "Real app" */; component: ComponentType<FrameSourceProps> }>()
FrameSourceProps = { meta: PrototypeMeta; children: (r: FrameResolution) => ReactNode }
FrameResolution = { status: "loading" }
  | { status: "unresolved"; title: ReactNode; detail: ReactNode }
  | { status: "found"; tag: string /* "/agents · this deploy" */; href?: string; render: (width: number, height: number) => ReactNode };
```

- The canvas renders one **+ <addLabel>** header button per contribution. It is
  disabled while that source is already on the canvas. The canvas never names "real
  app".
- compare contributes `{ id: "real-app", addLabel: "Real app" }`. Its component
  resolves `meta.mocks`: declared goes to `Counterpart.Kind.Dispatch`, none or
  malformed goes to `unresolved` with the existing notices. It maps the
  `CounterpartResolution` to a `FrameResolution` and drops `widths`, since width is
  canvas-wide now. `CounterpartResolution.found.render(width)` gains a `height`, which
  route iframes use.
- `href` is set for route/app kinds (`embedUrl(target, …)`), so Present's new browser
  tab can open it.
- The frame's DOM keeps `data-compare-half="mock"` (frame A) and
  `data-compare-half="counterpart"` plus `data-compare-status` (the source frame),
  from `compare/core`. So `compare-diff.ts` still finds both. canvas can't import
  compare, so canvas publishes its own generic `data-canvas-frame="<letter>"`, and
  compare's source component wraps its output in the `data-compare-*` element.

## Per-frame parts

- **Frame view** `<CanvasFrameView frame meta width height scale wholePage>`, exported
  for Present:
  - A prototype frame is a sandboxed iframe at the logical `width × height`, scaled.
    It keeps ScaledIframe's two-frame load swap, so an edit never blanks it.
  - `src = prototypeDocumentSrc(meta, frame.version, cacheBust, picks)`, using the
    shared picks for A.
  - Whole page measures with `usePageHeight` at the logical height, and reports it up
    for the Fit computation.
  - A source frame renders `resolution.render(width, height)` in a scaled box, inside
    a `PluginErrorBoundary`.
- **Version stepper**: `useVersionStepping(history, { shown, show })` becomes
  parametrized, with no context read. `VersionArrows` and `VersionList` take the pair.
  Label format: `v14 · latest` (dimmed suffix) / amber on a past version.
  `[`/`]` step the selected frame. The list ends with **Make vN the latest** on a past
  version, which uses `confirmRestore`, moved from `past-version-pill`.
  `version-steps.ts` and its test are kept as they are.
- **Options pill**: a per-frame `FloatingAction` pill, hover-revealed and sticky at
  the frame's bottom. Its summary is design · screen +N. The popover is headed
  "Options of B", reuses `OptionRows`, and adds who-letters, link and spread per row.
  It keeps `aria-label="Prototype options"` and the radiogroup/radio roles that the
  e2e scripts use.
- **Frame actions** slot `PrototypeFrameActions = defineItemActions<FrameActionProps>()`
  with `{ frame, meta }`. canvas contributes keep-only, duplicate and close. present
  contributes Present.
- **Swipe**: with 2 frames and layout `swipe`, it shows one box with B under A, A
  clipped to `swipeAt`, and a draggable divider (pointer events, no timers).
- **Keyboard** (surface-scoped `defineShortcut`): `F` presents the selected frame,
  `Esc`, `0` toggles 100%/Fit, and `[` `]`.

## Present (`present/web`)

- `PresentMenu` becomes a frame action. It has three rows (app tab / browser tab /
  full screen), and the first two carry a trailing new-tab icon.
  - New app tab: the tabs plugin's `navigate` / new-tab API from `apps-core/tabs`,
    opening the `present/<id>` route.
  - New browser tab: `window.open(embedUrl(presentRoute…))` for a prototype frame, or
    `href` for a source frame.
- `PresentOverlay` takes `{ frameId }` and reads frames from the canvas context. It
  renders `CanvasFrameView` at the overlay's room with the canvas size/zoom. Its hover
  chrome is the tag + stepper + "i of n · ← →", Exit, the options pill and the size
  chip. ←/→ step through the frames.
- **New-tab page** route `present/:name/:sha?/:picks?`:
  - `picks` is `a=b,c=d`, so a non-A frame's local variant survives. Without it, the
    page uses the shared picks.
  - It mounts a one-frame canvas provider. The existing `PortalHost`, fullscreen and
    Esc behaviour stays.

## Deletions

- **gallery**: `detail-actions.tsx` (StageSwitcher), `focus-stage.tsx`,
  `frame-size.tsx`, `past-version-pill.tsx`, `version-row.tsx`, the `PrototypeStages`
  and `PrototypeDetailScope` slots, and the `OptionsPicker` floating wrapper. The detail
  pane, context, stepper, list and `use-page-height` move to canvas.
- **compare**: see the table above. The `version` plugin goes, with its two e2e
  scripts.
- **Config**: `config/apps/prototypes/gallery/prototypes-detail.actions*.jsonc` and
  `version-actions*.jsonc` move to `config/apps/prototypes/canvas/`.
  - New header order: title, copy-id, done, spacer, layout (seg), add (+Frame and
    +sources).
  - `version-actions`: `open-conversation` only.
  - The regenerated `.origin` files come from the build.
- **Docs**: rewrite `canvas/CLAUDE.md`; trim `gallery`, `compare` and `present`'s
  CLAUDE.md files, and the root `prototypes/CLAUDE.md` sub-plugin list.
  `research/2026-09-10-global-prototype-counterpart-kinds.md` stays as history.

## E2E

- Replace `gallery/e2e/{frame-size,options-picker,stage-url,version-stepper}.ts` with
  `canvas/e2e/`:
  - `canvas-frames.ts`: + Frame, per-frame picks independent of A, link, spread,
    keep-only + Undo, close.
  - `canvas-size.ts`: presets, Fit vs slider, Whole page, drag snap.
  - `canvas-version.ts`: the per-frame stepper, and that the arrows don't move.
  - `canvas-url.ts`: `/compare` opens A + the real app, and + Real app writes it.
- Update `compare/e2e/compare-diff.ts`:
  - Open `proto/<id>/compare`.
  - Set 100% through the size chip's value button instead of the old `100%` radio.
  - Set `--width` by picking that preset in the size menu. A width that isn't a
    preset is refused, and the error lists the presets.
- Update `present/e2e/present-verify.ts` for the per-frame menu (hover frame A, then
  Present).

## Verification

1. Run `./equin test plugins/apps/plugins/prototypes` for the reducer, layout,
   frameName and version-steps tests.
2. Run `./equin build` in the background, then `./equin await`.
3. Run `compare-diff.ts` on a prototype that has a real-app counterpart, to screenshot
   the new pane at 1440×900 against the mock's scenes (vs-version, vs-app, spread,
   single).
4. Run the four canvas e2e scripts and `present-verify.ts`.
5. Use `screenshot.ts --path /prototypes/proto/proto-1790120832-wtfo` plus clicks
   (+ Frame, a size preset, Present) for a visual check.
