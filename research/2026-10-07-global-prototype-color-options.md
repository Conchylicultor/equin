# Color options for prototypes + an upgraded color picker

Mock: `proto-1791365853-o0r1` ("Color options in the variant picker").

## Context

Agents building prototypes keep declaring palette variants as enum options
(`palette: violet | indigo | azure`). The reader can only flip between the agent's
guesses; they cannot pick the color they actually want. Goal:

1. A generic **`color` option kind**: the agent declares named suggestions, the reader
   can pick any color, and the mock **repaints live while dragging — no reload**.
2. The picker that drives it is the app's existing `primitives/css/color-picker`,
   **upgraded** (it is shared: theme customizer, color config field, shadow tokens get
   the upgrade too).

Decided with the user: fitted (Okhsv-style) square only — no true-chroma variant; no
contrast readout; per-channel fields; the color option is a **row inside the existing
options popover** (suggestion chips + a custom swatch that expands the picker inline),
not a separate bar button.

## Part 1 — `primitives/css/color-picker` upgrade

Plugin: `plugins/primitives/plugins/css/plugins/color-picker/`.

### 1a. Color math moves to `core/`
- Move `web/internal/color.ts` → `core/internal/color.ts`, export `Color` from a new
  `core/index.ts` (pure TS, so `prototypes/files/core` can parse colors). Update the two
  external `Color` importers to the core barrel: `ui/theme-engine/plugins/theme-customizer/web/components/token-row.tsx`,
  `ui/tokens/plugins/shadow/web/components/shadow-section.tsx`.
- Add: `inGamut(l,c,h)`, `maxChroma(l,h)` (binary search on linear sRGB, as in the mock),
  `Color.fromCss` gains `hsl()` and `%`/`deg` tolerance; `toHslParts()` / `Color.fromHsl()`;
  `Color.toHex()` already exists.
- Drop the `MAX_CHROMA` export (no consumer outside `ColorArea`).
- New `core/internal/color.test.ts`: round-trips hex↔oklch↔hsl, `maxChroma` edge
  (result in gamut, +ε out), `fromCss` null for `var(--x)`, `calc()`, font names
  (token-row relies on that).

### 1b. Components (web)
- **`ColorArea`** — fitted: row `l` spans `0 → maxChroma(l, h)`; x = `c / maxChroma(l,h)`.
  Every point is displayable. Thumb filled with the current color. `role="slider"`,
  `aria-valuetext`, keyboard (↑↓ lightness, ←→ chroma, Shift ×10).
- **`HueSlider` / `AlphaSlider`** — filled thumbs, `role="slider"` + aria values, ←→/↑↓
  keyboard. Hue change clamps chroma into gamut (`fitC`).
- **`use-color-drag`** — add an `onEnd` callback (pointerup/cancel) → feeds `onCommit`.
- **`ColorInput` → `ColorValueFields`** (replaces the cycle button):
  - Format as `SegmentedControl` (`primitives/css/toggle-chip`), HEX · OKLCH · HSL, still
    persisted with `useDraft("color-picker-format")`; default becomes `oklch`.
  - Per-channel fields: OKLCH = L % · C · H °, HSL = H ° · S % · L %, HEX = one `#` field,
    plus A % when `showAlpha`. Each: type (live on valid number), ↑↓ nudge (Shift ×10),
    **drag the letter to scrub**. Range clamp, hue wraps, C/L clamped to gamut.
  - Internal `channel-field.tsx` + a pure `channels.ts` table (get/put/min/max/step/dp per
    channel) — unit-tested. (No generic scrub-number primitive exists; keep it internal
    for now.)
  - Copy button: `CopyButton` from `primitives/copy-to-clipboard` (copies in the shown format).
- **`SwatchGrid`** — `colors: readonly (string | { name: string; color: string })[]`.
  Named entries render the name under the dot (tooltip carries name + hex). Strings
  behave exactly as today (Sonata passes hex strings + `renderColor`; `onChange` still
  emits the original string).
- **`ColorPicker`** — new props, all optional so the 3 consumers stay unchanged:
  - `title?: string` → header: before/after split swatch (before = value at mount; click
    reverts) + title + subtitle (suggestion name / "Custom").
  - `defaultValue?: string` → Reset button (disabled when equal).
  - `onCommit?(oklch: string)` → fires on drag end, key-up, field blur/Enter, swatch /
    recent / eyedropper pick. `onChange` keeps firing per move (emission stays `toOklch()`;
    token-row, shadow-section and the color field depend on it).
  - Eyedropper button left of the hue slider, rendered only when `"EyeDropper" in window`.
  - **Recent**: `primitives/usage-rank` namespace `color-picker`, key = hex; `recordUsage`
    on commit (never per move), row read with `useRecentUsage(ns, 10)` inside a
    `ResourceView` (precedent: `apps/pages/plugins/page-tree/.../page-icon-button.tsx`).
    Suggestions are not recorded.
  - Width `w-56` → `w-64` (three channel fields + copy).
- **`ColorPickerPopover`** — `resetOnClose` so "before" is captured per open; passes the
  new props through.
- **Exhibit**: `exhibits/` with an isolated `color-picker/picker` (named swatches,
  default, alpha on/off) — lets a later prototype `mocks` it.
- **Tests**: `web/__tests__/color-picker.test.tsx` (jsdom): swatch click emits + commits,
  channel field typing emits, `onCommit` not fired during a drag move, Reset disabled at
  default, before-swatch reverts.

## Part 2 — `color` option kind (prototypes)

Root: `plugins/apps/plugins/prototypes/plugins/`.

### 2a. Declaration and default (`files/core/options.ts`, `option-source.ts`)
```html
<html style="--accent: #7c5cff">
<meta name="prototype-option"
      content="accent: color violet=#7c5cff | azure=#3b82f6 | mint=#10b981" />
.button { background: var(--accent); }
```
- After the colon, a leading `color` keyword makes it a color option; the rest are
  `name=<css color>` suggestions (0..n; names follow `VALUE_RE`, colors parsed with
  `Color.fromCss`, hex or `oklch()`).
- **The default is the `--<name>` custom property in `<html style>`** — one source of
  truth that renders by double-click off disk, in thumbnails (`file://`, no stamping —
  unchanged), and is exactly the property the app overrides. `readOptionSource` also
  collects `--*` declarations from the first `<html>`'s `style`.
- Types become a union: `PrototypeOption = ChoiceOption {kind:"choice",name,values,default}
  | ColorOption {kind:"color",name,suggestions:{name,color(hex)}[],default(hex)}`; wire
  `PrototypeOptionSchema` in `files/core/prototypes.ts` becomes a discriminated union
  (also carried by `PrototypeVersion.options`, so per-version reads work unchanged).
- `foldOptions` problems: missing/unparseable `--name` default, bad suggestion, duplicate
  suggestion name, `color` with a `data-<name>` instead of a style default (hint).
- A color option's pick value: a suggestion name or lowercase `#rrggbb` (stored as hex —
  readable by agents, URL-safe; the fitted area guarantees sRGB so nothing is lost).
  `files/core/picks.ts`: `StoredPicksSchema` value = `OptionValueSchema | HexColorSchema`.
- `resolvePicks`, `pickedValue`, `picksFromQuery` narrow on `kind`; new
  `pickedColor(option, picks): hex` (suggestion name → its hex).
- Tests: extend `files/core/options.test.ts` (parse, defaults from style, problems,
  query round-trip with `%23rrggbb`).

### 2b. Stamping (`files/server/internal/picked-document.ts`)
- `stampPicks`: choice → `data-<name>` (unchanged); color → set `--<name>: <hex>` in the
  `<html>` `style` (merge: replace that property, keep the rest). `prototype options`
  URLs, Present links and screenshots therefore render the picked color.
- Add the missing unit test for `stampPicks` / `servePickedDocument` (400 on an
  undeclared color value, merge of an existing style).

### 2c. Live delivery without reload (canvas)
- **Src never changes for a color pick.** `useFrameSrc` (`canvas/web/context.tsx`) builds
  the src from choice picks + `v`, and carries color picks only as of the last src
  change (frozen while only colors move). So a new frame / a choice change / an agent
  edit loads with the colors server-stamped (no flash), and a color change alone never
  reloads.
- **Applied in the frame**: `PrototypeFrame` (`canvas/web/components/prototype-frame.tsx`)
  gets an effect on `[ready, colorVars]` that sets
  `doc.documentElement.style.setProperty("--<name>", hex)` — the same pattern as
  `publishScreenHeight` (`canvas/internal/page-extent.ts`). Also applied in the hidden
  layer's `onLoad` before promotion.
- **Preview vs commit**: the canvas model (`canvas/web/internal/canvas-model.ts`) gains a
  local, unpersisted `preview: {option, value}` per frame (`previewPick` /
  `clearPreview` actions). Dragging dispatches `previewPick` (frame repaints every
  move, no network); `onCommit` dispatches the existing `setPick` (one PUT to
  `/api/prototypes/:name/picks`, other tabs follow via the live `prototypes.picks`
  value) and clears the preview. Link applies to colors like choices; **spread** on a
  color option spreads its suggestions.
- `colorVars(frame)` = per color option: preview ?? picked ?? default.

### 2d. Pill UI (`canvas/web/components/options-pill.tsx`)
- `OptionRow` branches on `kind`. Color row: label, suggestions as swatch chips (radio,
  name tooltip), a trailing custom swatch (current color, ring when not a suggestion)
  that expands an inline `ColorPicker` under the row (`title` = option name,
  `defaultValue` = default, swatches = suggestions, `onChange` → preview, `onCommit` →
  setPick). One row expanded at a time.
- `PillSummary`: color options show a dot + suggestion name or hex.
- Present (`present/web/components/present-stage.tsx`) reuses the pill and the frame →
  works unchanged. `present-link.ts` encodes `#` in `a=b,c=d` picks.

### 2e. CLI (`files/cli/options.ts`, `list.ts`)
- `prototype options <id>`: a color line prints `accent  #3b82f6 (azure) picked  color:
  violet=#7c5cff | azure=#3b82f6 | …`; `picked:` line in `list` shows hex/name.
- `compare/e2e/compare-diff.ts --options`: accepts a suggestion name or hex for a color
  option (picked through the endpoint path frame A uses).

### 2f. Docs & agent guidance
- `prototypes/CLAUDE.md` § Options: the `color` kind, the style default, "read
  `var(--name)`, never cache it in JS at load" (it changes without reload), and replace
  "options are choices only" with "colors are a `color` option, never a palette enum".
- `prototypes/_template/index.html` options comment: one color example.
- `gallery/web/components/launch-rules.ts` `OPTIONS_RULE`: same guidance.
- Plugin CLAUDE.md prose: `files/` (options, picks), `canvas/` (preview/commit, src
  freeze), `color-picker/` (new props, fitted area, recents).

## Verification

- `./equin test plugins/primitives/plugins/css/plugins/color-picker plugins/apps/plugins/prototypes`
- `./equin build` (background), then:
  - Theme customizer + a color config field + shadow tokens: picker opens, values still
    stored as `oklch(…)` / channels; Sonata track colors unchanged.
  - New e2e `canvas/e2e/color-option-verify.ts` on a fixture prototype declaring
    `accent: color …`: open the pill → pick a suggestion (frame `--accent` updates, no
    new iframe load), drag the square (computed `--accent` changes per move, frame
    `src` unchanged, zero PUTs until pointer-up, exactly one PUT after), reload the page
    → pick persisted; `prototype options <id>` prints the hex; its URL renders the color
    (stamped style). Picks restored by the agent-write ledger at the end.
  - Screenshot the expanded color row via `screenshot.ts --click`.
- `./equin check` (plugin docs in sync, boundaries — `prototypes/files/core` →
  `color-picker/core` is core→core).
