# Chrome Craft Overhaul — tokens, separators, radius, element polish

## Context

The app chrome reads as unpolished: mismatched paddings (`px-2`/`px-3`/`px-4` across three adjacent chrome zones), hardcoded heights (`h-12` toolbar vs `h-10` pane headers, on no shared scale), hard corners (the `Row` primitive uses bare `rounded` — Tailwind's static 0.25rem that bypasses the `--radius` shape token, so no shape preset can soften list rows), a "line ladder" of 3–4 stacked hairlines at the top-left corner, and three different vertical-separator techniques (CSS `border-r` ×2 vs a 4px `bg-border/60` div that is nearly invisible in dark mode).

Root cause: typography, control-size, and z-index were put on the token system with lint enforcement — **chrome dimensions and radius never were**. This plan finishes that wiring (the structural fix) plus a small element-level polish pass.

**Out of scope (explicitly):** toolbar item ordering/grouping/overflow — another agent owns that. This plan does not touch toolbar item order, the `group` field rendering, or the order config jsonc files.

## Decisions (settled)

1. **Chrome tokens extend the `density` token group** (not a new group, not static-only): chrome heights/padding are structural dimensions like control heights, and must scale with density presets.
2. **Two-tier heights, current values kept**: `chromeBarH` 3rem (toolbar + sidebar header, deliberately matched), `chromePaneH` 2.5rem (pane headers), one shared `chromePadX` 0.75rem so left edges align.
3. **One separator strategy**: true 1px hairlines everywhere; resize handle keeps its 4px hit-area but paints only a centered 1px line. Drop the toolbar's inner vertical `<Separator>` to de-ladder the corner.
4. **Row radius**: bare `rounded` → `rounded-md` (token-driven, ≈0.5rem default, responds to Shape presets).
5. **Lint**: new `radius/no-adhoc-radius` rule banning bare `rounded` and arbitrary `rounded-[…]` (NOT `rounded-none`/`rounded-full` — legitimate intentional shapes). Modeled on `no-adhoc-typography`. Skip a chrome-spacing lint (no precise fingerprint; the token migration itself is the guard).
6. **Progress indicator**: default variant `"dots"` → `"segmented"` (user choice).
7. **Avatar blank discs**: add deterministic fallback (user choice) — no avatar ever renders as an empty beige circle.
8. **Pinned queue card**: replace hardcoded rgba double-shadow with theme shadow token + full-opacity ring.

## Phase 1 — Chrome tokens in the density group

1. `plugins/ui/plugins/tokens/plugins/density/shared/group.ts` — add schema keys (camelCase → kebab CSS vars automatically):
   - `chromeBarH: { default: "3rem", label: "Chrome bar height" }`
   - `chromePaneH: { default: "2.5rem", label: "Chrome pane header height" }`
   - `chromePadX: { default: "0.75rem", label: "Chrome padding X" }`
   (`DensityTokenValues` + config sub-fields derive automatically.)
2. `plugins/ui/plugins/tokens/plugins/density/web/presets.ts` — add the three keys to all presets (TS errors if omitted):
   - comfortable: `3rem / 2.5rem / 0.75rem`
   - cozy: `2.75rem / 2.25rem / 0.625rem`
   - compact: `2.5rem / 2rem / 0.5rem`
3. `plugins/framework/plugins/web-core/web/theme/app.css`:
   - Default fallbacks in **both** `:root` and `.dark` (next to the control-height block, ~lines 178–181): `--chrome-bar-h: 3rem; --chrome-pane-h: 2.5rem; --chrome-pad-x: 0.75rem;`
   - Utilities after the control-height utilities (~line 319):
     ```css
     @utility h-chrome-bar { height: var(--chrome-bar-h); }
     @utility h-chrome-pane { height: var(--chrome-pane-h); }
     @utility px-chrome { padding-left: var(--chrome-pad-x); padding-right: var(--chrome-pad-x); }
     ```
   - No `@theme inline` mapping needed (direct-consumption utilities, like `p-row`).
   - The four sources (group default, `:root`, `.dark`, comfortable preset) must agree numerically.

## Phase 2 — Chrome consumers swap to utilities

4. `plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx`:
   - Toolbar header (line 75): `h-12 px-3` → `h-chrome-bar px-chrome`
   - Sidebar header (line 107): `h-12 … px-4` → `h-chrome-bar … px-chrome`
   - Remove the inner `<Separator orientation="vertical" className="h-5" />` (line 79).
5. `plugins/primitives/plugins/pane/web/components/pane-chrome.tsx` (line 66): `h-10 … px-2` → `h-chrome-pane … px-chrome`.
   - Leave the raw PopoverTrigger at line 279 as-is (already `rounded-md`; the only "clean" alternative imports `buttonVariants`, which `no-adhoc-control` bans).
6. `plugins/primitives/plugins/pane/web/components/pane-resolve-guard.tsx` (~line 82, skeleton twin): same swap so the skeleton stays aligned.

## Phase 3 — Separators + radius

7. `plugins/layouts/plugins/miller/web/components/resize-handle.tsx`:
   - Line 36: keep `w-1` on the **outer** div (pointer/drag target), remove its bg; add inner `<span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border group-hover:bg-primary/40" />` — crisp 1px line, visible in dark mode.
   - Collapse button (line 48): `rounded` → `rounded-md`.
8. `plugins/primitives/plugins/row/web/internal/row.tsx` (line 59): `rounded` → `rounded-md`. Blast radius: every list row, app-wide — screenshot sweep required.
9. Leave `app-rail.tsx` `bg-background` vs sidebar `bg-sidebar` layering as-is for now (flag only; theming question, not craft).

## Phase 4 — Element polish (markup normalization only — NO reordering)

10. `plugins/notifications/web/components/bell-button.tsx`: raw `<button size-8>` → `IconButton` (icon `MdNotifications`, label "Notifications"); unread badge becomes an absolute overlay on a `relative` wrapper **around** the IconButton (IconButton renders only the icon child).
11. `plugins/health/web/components/health-dot.tsx`: inner raw `size-2 rounded-full` span → `<StatusDot size="lg" className={…} />` (`primitives/status-dot`), keep the `size-8` centering div + `WithTooltip`.
12. `plugins/worktree-switcher/web/components/worktree-dropdown.tsx`: the `size-1.5 rounded-full bg-primary` dot → `StatusDot size="sm"`.

## Phase 5 — Queue calm

13. `plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx` (~lines 609–615, pinned/isTop card): `rounded-md ring-1 ring-border/80 shadow-[0_6px_16px_rgba(0,0,0,0.45),0_2px_4px_rgba(0,0,0,0.25)] -translate-y-px bg-sidebar` → `rounded-md ring-1 ring-border shadow-md bg-sidebar`.
14. `plugins/ui/plugins/segmented-progress-bar/core/config.ts:6`: `default: "dots"` → `default: "segmented"`. Verify the segmented renderer (flat `h-1` pills, ignores `compact`) renders well at queue-row width; if it overflows the row, constrain its container in `progress-bar-row.tsx` (`plugins/conversations/plugins/conversation-progress/web/components/progress-bar-row.tsx`), not the renderer.

## Phase 6 — Avatar deterministic fallback

15. `plugins/primitives/plugins/avatar/web/components/avatar.tsx`: when `icon`/`svgNodes` are absent, never render a blank disc:
    - Add `fallbackGlyph?: string` (single character, rendered centered, `text-*` per size) shown when there is no icon.
    - When no explicit `color`, derive the auto-color from `fallbackKey` (mechanism already exists for `color=null` — extend it to apply even when there's no icon, so the disc is tinted, not `bg-muted`).
16. `plugins/conversations/plugins/conversations-view/web/.../avatar-fallback.tsx` (the `AvatarFallback` in slots): pass `fallbackGlyph={conv.title?.[0]}` and `fallbackKey={conv.id}`.

## Phase 7 — `no-adhoc-radius` lint (last — after all migrations land)

17. Create `plugins/primitives/plugins/radius/` mirroring `z-layers`/`control-size`:
    - `package.json` (copy + rename), `CLAUDE.md`.
    - `lint/no-adhoc-radius.ts`: copy `plugins/primitives/plugins/text/lint/no-adhoc-typography.ts` shape verbatim (`collectTokens` + `baseClass` duplicated per precedent, `JSXAttribute` + `CallExpression` for `cn`/`clsx`, no tag filter). Ban: `baseClass(t) === "rounded"` or `/^rounded-\[/`. Message: use `rounded-sm/md/lg/…` (token-driven via `--radius`), or `rounded-full`/`rounded-none` for intentional shapes.
    - `lint/index.ts`: `{ name: "radius", rules: { "no-adhoc-radius": rule }, ignores: { "no-adhoc-radius": [allowlist] } }`. Generate allowlist **after** Phases 2–6: `rg -l -e '\brounded(\s|"|'\''|`)' plugins | sort` then prune migrated files; document the regen recipe in a header comment like `text/lint/index.ts:13–17`.
    - No registry edits — auto-discovered by `./equin build` via `lint.generated.ts`.

## Verification

1. `./equin build` after Phase 1 (app.css `@utility` and CSS vars are build-time) and again after Phase 7 (lint discovery). The build also restarts the server + redeploys.
2. Baseline screenshots BEFORE changes, then after: `bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/agents --out /tmp/chrome-after` + clipped 2× shots of toolbar / sidebar / pane-edge. Check: one shared left inset across sidebar header, toolbar, pane header; fewer stacked lines top-left; visible 1px column separators in dark mode.
3. Theme customizer: toggle density presets (Comfortable/Cozy/Compact) → chrome bar/pane heights scale; toggle Shape presets (Sharp/Rounded/Pill) → list rows now respond (previously frozen at 0.25rem).
4. `./equin check eslint` → `radius/no-adhoc-radius` is active; `row.tsx` / `resize-handle.tsx` NOT in the allowlist.
5. Queue: pinned card calmer; segmented pills render within row width; no blank avatar discs.

## Risks

- **app.css edits silently inert until `./equin build`** — highest "it didn't work" trap.
- **Four-source numeric agreement** (group default / `:root` / `.dark` / comfortable preset) must hold or themed vs unthemed diverge.
- **Row radius blast radius**: ~30 consumer plugins; soft visual change but sweep screenshots (tree, nav, menus).
- **Bell badge overlay**: badge must wrap the IconButton (relative+absolute), not nest inside; verify no clipping under the tooltip wrapper.
- **Resize-handle hit area**: keep `w-1` on the outer div; moving width to the inner line shrinks the drag target to 1px.
- **Allowlist staleness**: generate the radius allowlist only after Phases 2–6, or migrated files get wrongly exempted.
- **Concurrent toolbar-ordering agent**: this plan edits `app-shell-layout.tsx` (class swaps + Separator removal) and three toolbar item components (markup only). If the ordering agent touches the same files, coordinate merge order — content changes here are small and mechanical.
