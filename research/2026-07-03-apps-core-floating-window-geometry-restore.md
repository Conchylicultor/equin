# Restore floating-window geometry across surface-mode round-trips

## Context

The surface rendering mode is now a **single per-surface value** (docked / windows / solo),
selected from the `Surface.Placement` registry — changed in `b6b39f684 refactor(surface):
make rendering mode per-surface, not per-tab`. Each floating window's geometry
(`x,y,w,h,z,pinned,minimized,snap,restore` + `desktopId` + member tabs) lives in the floating
plugin's own store, keyed by a monotonic `WindowId`, persisted to `sessionStorage` under
`app-windows:${getTabId()}`.

**Symptom:** Leave windows mode (→ docked or solo) and return, and every window re-mints at a
cascaded **default** position/size instead of being restored where it was left. A page reload
does not help either, because the persisted blob is wiped too. The desktop should feel *hidden
and shown again*, not rebuilt.

## Root cause (confirmed)

`plugins/apps-core/plugins/surface/plugins/floating/web/components/floating-foreground.tsx` has
**two** effects:

```ts
// (A) keyed reconcile — runs on mount and whenever the retained id set changes
const retainedKey = retainedTabIds.join(",");
useEffect(() => {
  pruneWindows(new Set(tabIds), new Set(retainedTabIds));
}, [retainedKey]);

// (B) unmount-only cleanup — deletes EVERY window
useEffect(() => {
  return () => pruneWindows(new Set(), new Set());
}, []);
```

`FloatingForeground` is rendered by the dispatcher **only when the surface mode is `floating`**
(`surface-body.tsx:92,122` — `const Foreground = activeDef?.Foreground`). So switching the
whole surface to docked/solo **unmounts** `FloatingForeground` even though the tabs are still
open. Effect (B)'s cleanup then runs `pruneWindows(∅, ∅)`: in
`use-floating-windows.ts:572` every window has 0 live + 0 retained members, hits the case-3
`windows.delete(id)` branch, and `persist()`s the now-empty store — wiping sessionStorage.
Re-entering windows mode calls `readWindowForTab` (`use-floating-windows.ts:404`), finds nothing
in `tabToWindow`, and takes the **mint** path → fresh `defaultGeometry()` cascade.

Effect (B) is a **vestige of the pre-refactor per-tab-placement model**: it predates
`b6b39f684` (present since `97177fe99`). Back then the Foreground unmounted only when *no tab
used the floating placement*, so "unmount ⇒ no floating windows exist ⇒ delete the last empty
window" was correct. After the refactor, "unmount" means "the surface mode changed," which is
**not** the same as "no windows exist" — so the cleanup now destroys live geometry.

## Fix — remove the vestigial unmount cleanup

Delete effect (B) (the `useEffect(() => () => pruneWindows(new Set(), new Set()), [])` block and
its now-stale comment) from `floating-foreground.tsx`. Nothing else needs to change: the keyed
reconcile effect (A) already covers every case the cleanup was meant to handle, and it runs
**while the Foreground is mounted** rather than on teardown:

- **Last floating tab closes (while in windows mode):** the Foreground stays mounted (mode is
  still `floating`). When the closing tab's exit tween ends, `retainedTabIds` empties →
  `retainedKey` changes → effect (A) re-runs `pruneWindows(∅, ∅)` → deletes the now-empty
  window (case 3). Handled.
- **Stale entries (tabs closed while away from windows mode):** on re-entering windows mode the
  Foreground remounts and effect (A) runs with the current **live** `tabIds`, pruning windows
  whose members are all gone. Handled on re-entry.
- **Mode round-trip with tabs still open (the bug):** nothing unmounts the geometry store and no
  wipe runs, so each window is **restored** by `readWindowForTab` finding its live
  `tabToWindow` entry. Geometry (and the sessionStorage blob) survives, so it also survives a
  page reload. Fixed.

`pruneWindows`'s own semantics are correct and must **not** change — `pruneWindows(∅, ∅)` is a
legitimate "no live/retained tabs ⇒ delete empty windows" call when effect (A) makes it on a
genuine last-close. The only defect is the unmount *trigger*; we remove that caller.

### Files to modify

- `plugins/apps-core/plugins/surface/plugins/floating/web/components/floating-foreground.tsx`
  — remove effect (B) (lines ~40–51) and its comment; keep effect (A). Update the component
  docstring (lines 8–22) so it no longer claims the reconcile depends on an unmount cleanup.

## Regression test

Add a jsdom (vitest) test at
`plugins/apps-core/plugins/surface/plugins/floating/web/__tests__/floating-foreground.test.tsx`
(new `web/__tests__/` dir; auto-discovered by the root `vitest.config.ts`):

1. `vi.mock` the four child modules FloatingForeground renders (`./window-dock`,
   `./snap-preview-overlay`, `./tab-drag-overlay`, `./floating-tabs-bridge`) to render `null`,
   so the mount exercises only the effects, not child providers.
2. Seed a window for a tabId via the store's public API (`readWindowForTab`/`useTabWindow` path,
   or the exported mint/read helper in `use-floating-windows.ts`), then mutate its geometry (e.g.
   `bringWindowToFront` / a snap / a direct move) to a non-default box.
3. `render(<FloatingForeground tabIds={["t1"]} retainedTabIds={["t1"]} />)`, then `unmount()`.
4. Assert `getFloatingWindow` for `t1` **still exists** with the same non-default geometry —
   i.e. unmount (a mode switch) did not wipe it.

Also add a positive assertion that a genuine last-close still prunes: re-render effect (A) with
empty `tabIds`/`retainedTabIds` and assert the window is deleted — so the fix doesn't leak empty
windows.

Run: `bun run test:dom plugins/apps-core/plugins/surface/plugins/floating`.

## End-to-end verification

1. `./equin build`, then drive with the Playwright helper against
   `http://<worktree>.localhost:9000`:
   - Switch the surface to **windows** mode (the placement `SegmentedControl` in the action bar).
   - Drag a window to a distinctive position and resize it; note its box.
   - Switch to **docked** (and separately **solo**), then back to **windows**.
   - Confirm the window returns to the **exact** moved/resized box, not a default cascade. Repeat
     with a second window to confirm z-order + per-window geometry, and with a window moved to a
     second virtual desktop.
2. **Reload** the page while in docked mode, switch back to windows, and confirm geometry still
   restores (proves the sessionStorage blob is no longer wiped).
3. Use `bun e2e/screenshot.mjs` with `--out` before/after captures around the mode round-trip to
   visually diff window positions.

## Notes

- Pure removal — no change to `pruneWindows`, the store schema, persistence keys, or the
  dispatcher. Lowest-risk structural fix: it deletes the one caller that conflated "Foreground
  unmounted" with "no windows exist."
- Existing store tests (`use-floating-windows.desktops.test.ts`, `use-snap.test.ts`) already
  cover `pruneWindows` semantics and remain green; the new test guards the component-lifecycle
  regression they don't cover.
