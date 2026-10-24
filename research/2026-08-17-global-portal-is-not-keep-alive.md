# A portal is a positioning mechanism, not a mount-retention one

*Fixing `ViewportOverlay.active`'s false keep-alive claim, and the real remount it
was cited to justify in the solo (fullscreen) surface placement.*

## Context

`ViewportOverlay`'s `active` prop is documented — in its JSDoc
(`plugins/primitives/plugins/css/plugins/viewport-overlay/web/internal/viewport-overlay.tsx:18-22`)
and in its `CLAUDE.md:33-36` — as

> the extension point for keep-alive toggles like the per-tab solo placement,
> where the same React element must move in and out of the portal without
> remounting its subtree.

That is false. React reconciles a portal by the **identity of its container**:
`reconcileSinglePortal` reuses a fiber only when the current child is already a
`HostPortal` with the same `containerInfo`. `active ? createPortal(children, body)
: <>{children}</>` puts two different element kinds in one tree slot, so the
subtree is deleted and a new one built. Measured, not inferred, by
`plugins/primitives/plugins/adaptive-bar/web/__tests__/viewport-overlay-keepalive.test.tsx`
(`unmounts: 1`, `mounts: 2`, a fresh `useState`-minted instance id).

Two separable things are wrong.

**1. Documentation asserting a guarantee the code does not provide.** The urgent
half: no consumer passes `active` (all 10 call sites checked), so the prop's only
possible effect is to mislead the next author who needs real keep-alive.
`research/2026-08-16-global-adaptive-bar-relocating-overflow.md:77-99` already
retracts the claim in prose; the primitive's own docs were never corrected.

**2. A real runtime bug.** `plugins/apps-core/plugins/surface/web/components/surface-body.tsx:271`
repeats the claim in a comment and depends on it:

```tsx
return portalToBody ? createPortal(container, document.body) : container;
```

The surface mode is surface-wide, so entering or leaving solo flips that ternary
for **every open tab** and remounts every tab's `TabSurface`. It is mostly
invisible today because tab surfaces re-derive state from stores; it surfaces as a
lost scroll position, a dropped uncommitted edit, a refetch — and, in the browser
app, a reloaded page (every browser tab holds a persistent `<iframe>`,
`plugins/apps/plugins/browser/plugins/webview/web/components/viewport.tsx:28-31`).

## The fix: stop moving the tab, move the containing block

The portal exists for one reason: a solo tab is `fixed inset-0`
(`solo-placement.tsx:32`) and the surface backdrop is `transform-gpu`
(`surface-body.tsx:104`), which makes it the containing block — so without the
portal a fullscreen tab would be clipped to the content area, below the tab bar
and right of the rail.

So **remove the containing block instead of relocating the tab**. While a
placement that positions against the viewport is active, the backdrop drops
`transform-gpu`; nothing moves, no element type changes, and keep-alive is
preserved *because there is no longer a branch that could break it* (rung 1 — the
wrong thing has no spelling: `createPortal` leaves the file).

Tracing the surface proves this is safe and small:

- The backdrop's `position: relative` — not its transform — is what docked's
  `absolute inset-0` (`docked-placement.tsx:20`) and floating's geometry box
  resolve against. `relative` stays.
- An app's own viewport-pinned chrome (`fixed inset-y-0` sidebars) is bounded by
  the **per-tab content inset** at `surface-body.tsx:239`, a *different*
  `transform-gpu` that is untouched. The backdrop's transform is not what bounds
  it, contrary to the comment at `surface-body.tsx:96-99`.
- What the backdrop's transform actually buys is stacking isolation. Solo
  declares no `Backdrop`/`Foreground` and paints only the focused tab (every
  other tab is `display:none`), so while solo is active there is nothing inside
  the surface that could leak into the root stacking context.
- `overflow-hidden` does not clip a `fixed` descendant once the clipper is no
  longer its containing block, so the same change lifts the clip.

The drop is **conditional** on the active placement, so docked and floating stay
byte-identical.

### Why not the relocation route

The alternative was to keep the portal but make it a real keep-alive seam: mint
one stable container per tab and re-parent it imperatively — the mechanism
`primitives/adaptive-bar` already uses (`web/internal/bar-item.tsx:67-93`,
`web/internal/relocate.ts`), extracted into a shared primitive.

Rejected, because a re-parent is destructive in ways React cannot see and
`relocate.ts:1-13` enumerates them: it releases pointer capture, drops an open
popover out of the top layer, resets inner scroll offsets, restarts CSS
transitions, blows away focus — and **reloads an `<iframe>`**. `moveBefore` fixes
all of it and WebKit does not have it, which is the engine `tauri/` ships on
macOS. adaptive-bar's answer to an iframe occupant is to refuse the move; a user
asking for fullscreen cannot be refused. That route would have preserved React
state and destroyed DOM state — the worse half of the same bug, under a primitive
named "keep-alive". The non-moving fix has none of these costs on any engine.

(No shared relocation primitive is extracted, then: adaptive-bar remains its only
consumer, and extracting for a second consumer that no longer exists would be
speculative generality. Its docs stay the pointer for anyone who needs it.)

### The invariant this introduces, and how it is enforced

Alternative-3's risk is real: "no ancestor of the surface may establish a
containing block" is a runtime DOM fact crossing plugin boundaries, exactly the
kind `no-adhoc-viewport-overlay` exists because lint cannot see. Today the chain
above the backdrop is clean (`marker-middleware`'s `display:contents` span →
`RailFraming`'s Stack → `apps-layout`'s flex div → `Stack h-full` → web-core root
→ `body`), but a future `filter` / `will-change` / `contain` / `perspective`
anywhere on it would silently clip fullscreen back to the content area.

So it ships with **rung 4**: when a viewport-relative placement activates, walk
the backdrop's ancestor chain to `documentElement`, and fail loudly naming the
offending element and property (dev throw / prod report, the `diagnostics.ts`
idiom adaptive-bar already uses). A regression then announces itself instead of
showing up as "fullscreen is 40px short" in someone's screenshot.

## Work

### Phase 1 — the surface (the runtime bug)

| file | change |
|---|---|
| `plugins/apps-core/plugins/surface/web/slots.ts` | `portalToBody?: boolean` → `viewportRelative?: boolean` ("containers position against the viewport, so the surface must not be their containing block"). Correct the keep-alive prose on `PlacementDef` — what preserves the mount is a stable element type and an unchanged parent chain. |
| `plugins/apps-core/plugins/surface/plugins/solo/web/solo-placement.tsx` | `portalToBody: true` → `viewportRelative: true`; rewrite the "portals its container to `document.body`" paragraph. |
| `plugins/apps-core/plugins/surface/web/components/surface-body.tsx` | backdrop `transform-gpu` becomes conditional on the active placement; delete the `createPortal` import, the `portalToBody` read and the toggle (`return container`); rewrite the two comments that are wrong about what the transform buys and what keeps a tab alive. |
| `plugins/apps-core/plugins/surface/web/internal/assert-viewport-containing-block.ts` (new) | the ancestor walk + loud failure, called from a layout effect gated on the active placement. |
| `plugins/apps-core/plugins/surface/web/__tests__/mode-switch-keepalive.test.tsx` (new) | stub two placements (one plain, one `viewportRelative`), mount a probe, flip the mode: `mounts === 1`, `unmounts === 0`, same instance id, **and the same DOM node object** — node identity is the half a reintroduced re-parent would break. |

### Phase 2 — the false claim (do the test move first; it imports `active`)

| file | change |
|---|---|
| `plugins/primitives/plugins/adaptive-bar/web/__tests__/viewport-overlay-keepalive.test.tsx` | moves to `plugins/primitives/plugins/css/plugins/viewport-overlay/web/__tests__/portal-toggle-remounts.test.tsx`, rewritten to probe a locally-defined conditional portal (the shape, not the prop) — it was always a viewport-overlay test living in adaptive-bar. |
| `plugins/primitives/plugins/css/plugins/viewport-overlay/web/internal/viewport-overlay.tsx` | delete `active` (prop, destructure, early return); rewrite the JSDoc: a portal positions, it does not retain. |
| `plugins/primitives/plugins/css/plugins/viewport-overlay/CLAUDE.md` | drop the `active` bullet; add "A portal toggle is not keep-alive" stating the reconciler rule and pointing at what to do instead (change the ancestor's containing block — `apps-core/surface`; or the stable-container relocation adaptive-bar documents). Prose above the AUTOGENERATED marker only. |
| `plugins/primitives/plugins/adaptive-bar/CLAUDE.md` | update the sentence that cites the moved probe. |

### Phase 3 — enforcement

`plugins/primitives/plugins/css/plugins/viewport-overlay/lint/no-portal-toggle.ts`
(+ registration in the existing `lint/index.ts`, + a RuleTester test alongside
`no-adhoc-viewport-overlay.test.ts`). It must catch all three spellings of the
mistake, because the two real instances used two different ones:

1. `cond ? createPortal(…) : <non-nullish>` (surface-body's shape);
2. a function that returns `createPortal(…)` on one path and a non-nullish
   non-portal on another (`if (!active) return <>{children}</>` — ViewportOverlay's
   shape, which a ternary-only rule would miss entirely);
3. `createPortal(children, cond ? a : b)` — a container swap, the same remount.

`… : null` stays valid: a genuine mount/unmount is not a broken keep-alive claim.
Both real sites are fixed by this plan, so the rule lands with zero disables.

## Verification

- `./equin test plugins/apps-core/plugins/surface` and
  `plugins/primitives/plugins/css/plugins/viewport-overlay` — the new suites; plus
  `plugins/primitives/plugins/adaptive-bar` unchanged (58 bun + 17 vitest green at
  baseline).
- `./equin check` — `type-check`, `eslint` (the new rule runs repo-wide),
  `plugins-doc-in-sync`.
- `./equin build`, then at `http://att-1786956371-h9fr.localhost:9000`:
  open a Browser tab on a loaded page, a scrolled conversation, and a page with
  unsaved text; enter fullscreen and leave with `Esc`. Nothing reloads, nothing
  scrolls back to the top, the text is still there. Confirm fullscreen still
  covers the tab bar and the rail, that a dropdown opened inside the solo'd app
  still paints above it, and that docked ⇄ windows ⇄ solo round-trip in both
  directions.
- `plugins/apps-core/plugins/surface/e2e/solo-keepalive.ts` (new, manual): stamps
  a marker on the live tab-surface node, toggles solo, and fails if the node
  identity or the stamp is gone, or if the solo container's rect is not the full
  viewport.
