# Overlay crash isolation — contain a crash to the overlay, not its launching chrome

## Context

When a component rendered inside a transient overlay (popover / dialog / dropdown /
select / tooltip content) throws during render, the crash is **not** isolated to the
overlay. It takes down the trigger and the surrounding chrome.

Observed instance: the config gear inside the Improve popover's Preprompt picker threw
`usePaneStore(): no <PaneSurfaceProvider>`. The crash surfaced as
`action-bar.item / improve crashed` and replaced the whole Improve action-bar item with a
full-width crash banner — instead of staying confined to the open popover.

**Root cause.** React error boundaries catch by React-tree *position*. A popover's content
is DOM-portaled to `document.body` but is still a **React child** of its trigger's subtree.
The only boundary in that subtree today is the per-slot `PluginErrorBoundary` applied by
`ErrorBoundaryMiddleware` (`registerSlotItemMiddleware`, priority 100) around the *entire*
`ActionBar.Item` contribution — trigger **and** popover as one unit. A crash in the portaled
content bubbles to that single boundary and unmounts the whole thing, painting the fallback
where the trigger used to be. There is no boundary around the overlay *content* itself.

> Note: the specific `usePaneStore` throw is already fixed on HEAD (commit `031ab89e9` — the
> config gear now navigates cross-app). This plan does **not** re-fix that instance; it
> eliminates the *class* — any future crash inside any overlay stays contained.

## Goal

Give transient overlay content its own error boundary at a **structural, automatic** choke
point, so a crash shows the error *inside the overlay* and leaves the launching chrome (the
action-bar button, the surrounding bar) intact — with zero per-consumer opt-in.

## Where the boundary belongs — and the constraint that shapes it

The single shared content choke point for **every** overlay except one is ui-kit's base-ui
`*Content` components, each rendering `{children}` once inside a `*Primitive.Popup`:

- `PopoverContent`, `DialogContent`, `DropdownMenuContent`, `SelectContent`, `TooltipContent`
  in `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/*.tsx`.
- The one exception is `floating-surface`, which bypasses ui-kit and renders
  `<ViewportOverlay><Surface>{children}</Surface></ViewportOverlay>`.

Wrapping only the *wrapper* primitives (`InlinePopover`, `imperative-dialog`, `cursor-menu`,
…) is **not** enough: direct ui-kit `*Content` consumers are numerous (~8 `PopoverContent`,
~11 `DropdownMenuContent`, **12 `SelectContent`** — Select has no wrapper primitive at all,
~3 direct `DialogContent`). True isolation must live at the ui-kit `*Content` layer.

**Hard constraint — dependency cycle.** ui-kit sits at the bottom of the plugin DAG, and
`error-boundary` transitively depends on it (`error-boundary → css/text → ui-kit`, confirmed:
`css/plugins/text/web/internal/text.tsx` imports `useSingleLine` from the ui-kit barrel). So
ui-kit **cannot** import `error-boundary`/`PluginErrorBoundary` — that closes the cycle
`ui-kit → error-boundary → css/text → ui-kit`, which the boundary checker rejects. This is
the identical constraint ui-kit's CLAUDE.md documents for `Frame`.

**Resolution — a fallback-injection seam.** A new **React-only leaf primitive**
(`primitives/overlay-boundary`, deps: `react` only) provides the boundary class plus a
module-level fallback registry. ui-kit imports the leaf (terminal edge — no cycle) and wraps
its `*Content` children. `error-boundary` — which sits *above* ui-kit — injects the existing
rich `CrashFallback` into the registry at boot. The boundary logic lives low; the fallback UI
is filled from above. This mirrors established patterns in the codebase (error-boundary
registers middleware *into* slot-render; `reports.crash` registers *into* `boundaryReportSink`).

Reusing `CrashFallback` means overlay crashes flow through **all** existing infrastructure
unchanged: `boundaryReportSink.emit` → `reports.crash` → the notification bell, plus the
`ErrorBoundary.Action` "Fix" button. The `kind` (`"popover"`, `"dialog"`, …) flows into
`report.slot`, so the fallback tag reads e.g. `popover crashed`.

Isolation is then a pure consequence of React resolving to the **nearest** boundary: the
inner `OverlayBoundary` catches before the crash can reach the slot-level `PluginErrorBoundary`
wrapping the trigger. **No change to `PluginErrorBoundary` or the middleware is needed.**

## Implementation

### 1. New leaf primitive `plugins/primitives/plugins/overlay-boundary/`

Mirror the `primitives/surface-id` skeleton (three files; pure, no `register()`).

- **`package.json`**
  ```json
  { "name": "@singularity/plugin-primitives-overlay-boundary", "private": true, "version": "0.0.1" }
  ```
- **`web/internal/overlay-boundary.tsx`** — class boundary + single-renderer registry:
  ```tsx
  import { Component, type ErrorInfo, type ReactNode } from "react";

  export interface OverlayFallbackProps {
    error: Error;
    componentStack: string | null;
    retry: () => void;
    kind: string;
  }
  type OverlayFallbackRenderer = (props: OverlayFallbackProps) => ReactNode;

  // Single global renderer, injected by error-boundary at boot. This is the seam
  // that breaks the ui-kit → error-boundary cycle: ui-kit owns the boundary +
  // registry (low in the DAG); error-boundary fills the fallback from above.
  let renderOverlayFallback: OverlayFallbackRenderer | null = null;
  export function registerOverlayFallback(fn: OverlayFallbackRenderer): void {
    renderOverlayFallback = fn;
  }

  interface Props { kind: string; children: ReactNode; }
  interface State { error: Error | null; componentStack: string | null; }

  export class OverlayBoundary extends Component<Props, State> {
    state: State = { error: null, componentStack: null };
    static getDerivedStateFromError(error: Error): Partial<State> { return { error }; }
    componentDidCatch(_e: Error, info: ErrorInfo) {
      this.setState({ componentStack: info.componentStack ?? null });
    }
    private retry = () => this.setState({ error: null, componentStack: null });
    render() {
      if (this.state.error) {
        if (renderOverlayFallback) {
          return renderOverlayFallback({
            error: this.state.error,
            componentStack: this.state.componentStack,
            retry: this.retry,
            kind: this.props.kind,
          });
        }
        // Minimal text-only fallback for the pre-registration edge only
        // (error-boundary registers the real CrashFallback at boot). Text-only ⇒
        // no `no-adhoc-layout` exemption needed.
        return (
          <button type="button" onClick={this.retry} title={this.state.error.message}>
            content failed · Retry
          </button>
        );
      }
      return this.props.children; // healthy: no DOM node, transparent (like SingleLineProvider)
    }
  }
  ```
- **`web/index.ts`** — pure barrel: re-export `OverlayBoundary`, `registerOverlayFallback`,
  `type OverlayFallbackProps`, plus a `satisfies PluginDefinition` default with
  `contributions: []`. No `register()`.
- **`CLAUDE.md`** documenting the seam + cycle rationale.

### 2. Wrap the five ui-kit `*Content` components

Add `import { OverlayBoundary } from "@plugins/primitives/plugins/overlay-boundary/web"` and
wrap the existing `{children}` region as the outermost child *inside* the Popup:

- `.../ui/popover.tsx` (~L74) — `<OverlayBoundary kind="popover">` around the existing
  `<SingleLineProvider><ContentScope>{children}</ContentScope></SingleLineProvider>`.
- `.../ui/dialog.tsx` (~L59) — same shape, `kind="dialog"`.
- `.../ui/dropdown-menu.tsx` (~L59) — `kind="dropdown"`, placed **inside** `SingleLineProvider`
  wrapping `{header}{children}`.
- `.../ui/select.tsx` (~L101) — `kind="select"`, **inside** `<SelectPrimitive.List>` around
  `{children}`.
- `.../ui/tooltip.tsx` (~L61) — `kind="tooltip"` around `{children}` (leave the sibling
  `TooltipPrimitive.Arrow` outside).

**"Do not edit by hand" is not violated in spirit:** these shadcn files already carry
hand-authored wraps (`SingleLineProvider` / `ContentScope`, grid tracks, eslint-disable
comments). `OverlayBoundary` is the same class of deliberate local wrap.

**Roving-focus safety (dropdown/select):** `OverlayBoundary` renders `children` with no DOM
node when healthy — indistinguishable from the `SingleLineProvider` that *already* wraps
`DropdownMenuContent`'s children and works. base-ui Composite registers items via context on
mount and navigates by DOM order, not React child position. No exclusion needed. (If a live
regression ever appears, the fallback is to drop `kind="select"`/`"dropdown"` and cover those
two via their wrapper primitives — not warranted given the precedent.)

### 3. error-boundary: extract `CrashFallback` + inject the renderer

- Extract the private `CrashFallback` (currently in
  `error-boundary/web/components/plugin-error-boundary.tsx:53-125`) verbatim into a new
  exported `web/components/crash-fallback.tsx`; repoint `plugin-error-boundary.tsx` to import
  it (behavior stays byte-identical).
- In the barrel's `register()` (rename `web/index.ts` → `web/index.tsx` for JSX), alongside the
  existing `registerSlotItemMiddleware` call, add:
  ```tsx
  registerOverlayFallback(({ error, componentStack, retry, kind }) => (
    <CrashFallback report={{ error, componentStack, slot: kind, label: null }} retry={retry} />
  ));
  ```

### 4. floating-surface

In `floating-surface/web/internal/floating-surface.tsx` (~L186), wrap `{children}` inside
`<Surface>` with `<OverlayBoundary kind="floating">`.

### Reset semantics

base-ui Popups unmount content on close by default, so closing and reopening a crashed overlay
remounts `OverlayBoundary` fresh and clears the error for free. The reused **Retry** button
covers residual cases (`keepMounted` surfaces, retry-without-closing). No extra wiring.

### Codegen / boundaries

No manual boundary-config edits. Cross-plugin deps are import-derived: `./equin build`
regenerates `web.generated.ts` with the `overlay-boundary` leaf (`dependsOn: []`) and appends
it to ui-kit / error-boundary / floating-surface automatically. The new barrel is pure and its
only imports are `react` + the framework `PluginDefinition` type, so no cycle is introduced.

## Suggested ordering

1. Create the `overlay-boundary` leaf (package.json, internal, barrel, CLAUDE.md).
2. `./equin build` (registers the plugin so `@plugins/...` imports resolve).
3. Extract `CrashFallback` → `crash-fallback.tsx`; repoint `plugin-error-boundary.tsx`.
4. Wire `registerOverlayFallback` in the error-boundary barrel (`index.tsx`).
5. Wrap the five ui-kit `*Content` components.
6. Wrap `floating-surface`.
7. `./equin build` + `./equin check` (plugin-boundaries, eslint, in-sync).

## Critical files

- `plugins/primitives/plugins/overlay-boundary/**` (new leaf)
- `plugins/primitives/plugins/error-boundary/web/components/plugin-error-boundary.tsx`
- `plugins/primitives/plugins/error-boundary/web/components/crash-fallback.tsx` (new)
- `plugins/primitives/plugins/error-boundary/web/index.tsx` (renamed)
- `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/{popover,dialog,dropdown-menu,select,tooltip}.tsx`
- `plugins/primitives/plugins/floating-surface/web/internal/floating-surface.tsx`

## Verification (end-to-end)

1. `./equin build` succeeds; `./equin check` passes (plugin-boundaries confirms no
   cycle, eslint clean, registry in-sync).
2. **Isolation, real app:** temporarily add a throwing child inside a popover's content (e.g. a
   component that `throw new Error("boom")` on render) reachable from the Improve popover, deploy,
   and open it via a scripted Playwright run against `http://<worktree>.localhost:9000`. Confirm:
   the crash banner renders **inside the open popover**, the Improve trigger button stays present
   and clickable, and the global action bar is intact. Remove the throwing child.
3. Confirm the crash still reaches Reports (a `reports.crash` entry / bell) with a tag derived
   from `kind` (e.g. `popover crashed`), and that the "Fix" action appears in the fallback.
4. **Roving focus regression check:** open a `Select` and a `DropdownMenu` (e.g. a data-view sort
   direction picker); confirm arrow-key navigation and typeahead still work.
5. Confirm reopen-after-crash clears the fallback (unmount reset) and that **Retry** clears it
   in place.
