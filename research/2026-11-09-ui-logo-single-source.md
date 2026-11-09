# ui/logo — the equin logo from one source

## Context

The logo was just redesigned ("airy bold", small lift; prototype `proto-1794232441-v3fojx`):
a ¾ outer arc folding into three bowls (full master, ≥ 28 px) or two bowls with a
heavier line (small master, < 28 px), blue → violet gradient.

It is currently written out by hand in six places, which already drifted once (the
tray used a different path, the tab bar kept an inline copy):

| copy | what it draws |
|---|---|
| `web-core/web/public/icon.svg`, `icon-small.svg` | full / small, gradient |
| `web-core/web/public/icon_{16,32,512}x….png` (+ unused 64/128/256) | rasterized favicons / apple-touch |
| `apps-core/tab-bar/web/components/chrome-mark.tsx` | small, inline path, currentColor |
| `agent-manager/shell/web/components/equin-mark.tsx`, `app-launcher.tsx:129`, `menu-bar/web/components/panel-header.tsx` | `<img src="/icon(-small).svg">` |
| `menu-bar/rust/icons/{app,tray,tray-attention}.svg` | full on white tile; small mono (+ attention dot knockout) — read by `build.rs` |

Goal: one plugin owns the geometry as data; every in-app use imports its component; every
static file is generated from it and a check fails when one drifts. A redesign = one edit.

## Design

### `plugins/ui/plugins/logo`

**`core/`** — pure, dependency-free (importable by web, `scripts/`, `check/`):

- `LOGO` — the geometry as parameters, not path strings:
  `{ center: 50, outerRadius: 38, arcStartDeg: -90, lift: 4,
     masters: { full: { bowls: [29, 20, 11], stroke: 6.72 },
                small: { bowls: [27, 16], stroke: 9 } },
     smallBelowPx: 28,
     gradient: { from: "#3b82f6", to: "#8b5cf6", x1: 88, y1: 12, x2: 12, y2: 88 } }`
- `logoPath(master, { startDeg? })` — builds the `d` (outer arc → straight rise of `lift` →
  alternating bowls), the same construction as the prototype's `airyPath`.
- `logoSvg(opts)` — the one SVG renderer, used by the files and the web component:
  `{ master, paint: "gradient" | "currentColor" | <color>, tile?: { fill, inset, rx, scale },
     attention?: { dot, knockout } , size?, idPrefix? }`.
  `attention` derives the trimmed arc start from the knockout circle (the angle where the arc
  leaves the knockout + half the stroke) — no hand-computed `87.22 42.36`.
- `LOGO_FILES` — the closed list of generated static files, as data:
  `{ path, render: () => string | {png, size, master} }` for the 5 SVGs and 3 PNGs.

**`web/`** — `<Logo className tone="gradient" | "current" />`: inline SVG from `logoSvg`
(gradient id from `useId`). It draws **both** masters and shows one by a container query
(`@container` wrapper, small master `@max-[27.99px]:block`, full hidden) — so the < 28 px
rule lives once, in the component, and callers only size it (`size-5`,
`size-sidebar-brand-mark`, …) as today. Precedent for `@max-[…]` in components:
`image-viewer/web/components/viewer-grid.tsx:117`.

**`scripts/render.ts`** — `./equin run plugins/ui/plugins/logo/scripts/render.ts` writes every
`LOGO_FILES` entry. PNGs are rasterized with `@resvg/resvg-js` (already a dep of
`app-manifest` / `release`; `font: { loadSystemFonts: false }` per lint
`no-resvg-system-fonts`) and carry the sha256 of their source SVG in a PNG `tEXt` chunk
(`equin-logo-source`) — the same idea as the inputs hash `ui/icons` embeds
(`readInputsHash`, `ui/icons/check/index.ts`).

**`check/index.ts`** — `logo:files-in-sync`: each SVG byte-equal to `logoSvg(...)`; each PNG
exists, has the right size, and its `tEXt` digest equals the digest of the SVG it should be
rendered from (no pixel compare, so not tied to the rasterizer's version). Hint: run the
script. Reads through `ctx.repo()` (`Check` from `@plugins/framework/plugins/tooling/core`).

No central codegen edit: the files change only when `core/` does, which the check catches at
`build`/`push` (precedent: `ui/icons/scripts/vendor-seti.ts` + its check).

### Consumers

- `tab-bar/chrome-mark.tsx` → `<Logo tone="current" className="size-4" />` (drops the inline path).
- `agent-manager/shell` → its `Apps.App` `mark` is `Logo`; delete `equin-mark.tsx`.
- `app-launcher.tsx:129` and `menu-bar/panel-header.tsx` → `<Logo className=… />`.
- `web-core/web/index.html` keeps its static `<link rel="icon">` tags, pointing at the
  generated files (`/icon-small.svg`, 16/32 PNGs, 512 apple-touch).
- `menu-bar/rust/build.rs` unchanged — it reads the generated `icons/*.svg`.
- Delete the unused `icon_64x64.png`, `icon_128x128.png`, `icon_256x256.png`.
- Fix the prose references (app-launcher `CLAUDE.md:9`, comments in panel-header).

## Files

New: `plugins/ui/plugins/logo/{package.json, CLAUDE.md, core/index.ts, core/internal/*.ts,
web/index.ts, web/components/logo.tsx, scripts/render.ts, check/index.ts, core/*.test.ts}`.
Modified: `chrome-mark.tsx`, `app-launcher.tsx`, `panel-header.tsx`, agent-manager
`shell/web/index.ts`, `web-core/web/index.html`; regenerated static files.

## Verification

- `./equin test plugins/ui/plugins/logo` — `logoPath` reproduces today's hand-written paths
  exactly (full, small, attention start ≈ 87.22 42.36); `logoSvg` snapshot of each file.
- Run the render script → `git diff` shows the SVGs unchanged in shape (today's files are the
  reference), PNGs re-encoded with digests.
- `./equin check logo:files-in-sync` passes; edit a stroke in `core/` → it fails naming the files.
- `./equin build`; screenshot sidebar header (24 px → small), tab bar (16 px, current colour),
  menu-bar panel header (30 px → full) with `browser_*`.
