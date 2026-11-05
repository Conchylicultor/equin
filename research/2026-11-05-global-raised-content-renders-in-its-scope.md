# Raised content renders in the scope that raised it

Task: task-1793855237-at1lm3 — "A toast raised inside the demo renders, and acts, through the page's
transport" (supervisor conv-1793665695-3p52r4). Follow-up of
research/2026-11-05-global-ambient-signals-scoped.md, which closed the ambient-signal half of the
class and left the render hand-off half open.

## Context

Some APIs take content from a caller and render it in a host mounted elsewhere, as page chrome
(`Core.Root`). The content then renders under the host's React contexts, not the caller's. Inside
`/demo` (`<DemoScope>` → `<PluginScope>` → `<AppEmbed>`) the host's contexts are the page's:
its transport (the real server), its plugin registry and the page's tabs navigator.

Inventory of every imperative render hand-off in web code (module store or global API → host):

| Hand-off | Raised from a scope? | Content reads context? | Outcome |
| --- | --- | --- | --- |
| `showToast({ render })` → sonner → `ToasterHost` (`shell/toast`), only caller `toastNotification` (`useToast`, the bell's arrivals) | yes (`useToast` is used across the agent manager) | yes: `Notifications.Action` registry, each kind's `useLink` / `useRun` (Retry calls `resume` through the PAGE's fetcher; `open` navigates the PAGE's tabs), `useIdKinds`, `useAudience` | **closed** (below) |
| `openDialog(render)` / `confirmDialog` → module store → `ImperativeDialogHost` (`overlay/imperative-dialog`) | yes: the desktop's wallpaper picker, Sonata's UG import and Transcribe dialogs, the prototypes canvas's version confirm, the pages/places confirms… | yes: `useSetConfig` / `useFetchEndpoint` / slots (the wallpaper picker writes the wallpaper config to the real server from `/demo`) | **closed** (below) |
| `showToast({ title, description, action })` (text toast) | yes | no: strings, and closures the caller built under its own hooks (`onClick`, a `LinkTarget` from `useAppLink`) | data only — stays a plain function |
| Hint / tour declarations → `HintHost` | define-time content, raised by `useHintMoment` | — | already closed: `useHintMoment` inside a `PluginScope` asks nothing |
| Ask card store → `AskHost` | page chrome only | — | data only |
| Radix/ui-kit portals, `SurfaceOverlay`, `PortalHost` | — | — | React portals from the caller's own tree: context preserved |

## Design

**Content a caller raises renders in the caller's render origin; page chrome only places it.**

New primitive `primitives/scope/render-origin` (web), next to the other "which mounted instance
does this belong to" answers:

```tsx
<RenderOrigin>{children}</RenderOrigin>      // a subtree's own origin: raised content renders HERE
const origin = useRenderOrigin();            // the caller's origin (captured by a hook)
const raised = origin.raise(node, { onGone }); // { update(node), remove(), mounted: Promise<void> }
```

- `<RenderOrigin>` renders its children, then every node raised into it, in its own position of
  the React tree — so raised content sees exactly the contexts at the origin: the scope's
  transport, registry, navigator, theme.
- The page's origin is the plugin's own `Core.Root` host (`PageRenderOrigin`): content raised by
  code outside every origin renders there — the same contexts the toast / dialog hosts gave it
  before, so the real app is unchanged.
- **Scope check** (the guarantee): `useRenderOrigin()` answers the nearest origin only when it
  was mounted in the reader's own `PluginScope` (`usePluginScopeId()` on both sides). A reader in a
  scope with no origin of its own throws, naming the scope — it can never fall through to the
  page's. Outside every scope, no origin in context → the page's.
- Lifetime: when an origin unmounts, everything raised into it is unmounted and each raise's
  `onGone` runs (a dialog's promise settles, a toast is dismissed).

Origins in scope: `DemoScope` mounts one inside its `PluginScope` (the backstop for anything in
the scope); `AppEmbed` mounts one inside its tab set and app theme — the nearest one, so a raised
link navigates the embed, never the page.

### Toasts

- `showToast(args: ToastArgs)` keeps only the text shape (data only). The custom shape leaves it.
- New `useShowCustomToast(): (args: CustomToastArgs) => void` (toast plugin): captures the
  caller's origin. The body (chrome `Theme` + `ContentScope` + `render({ dismiss })`) is raised
  into the origin as a `createPortal` into a detached element; once that has committed
  (`raised.mounted`), the sonner toast is enqueued with a placement that ADOPTS the element into
  its `<li>` in a ref callback (layout phase) — so sonner's first height measurement already sees
  the content, and React events still bubble through the origin's tree. Dismiss → `remove()`;
  the origin going away → `dismiss`.
- `toastNotification` becomes `useToastNotification()`; `useToast` and the bell's arrivals use it.
  So a notification raised in the demo resolves its action kind in the demo's registry, Retry
  calls the demo's server, Open navigates the embed.

### Dialogs

- `openDialog` / `confirmDialog` become `useOpenDialog()` / `useConfirmDialog()`, raising a
  controlled `<Dialog>` into the caller's origin (`DialogContent` portals to the body itself, and
  carries the origin's theme scope). `ImperativeDialogHost` and the module store are deleted —
  the page's origin is the page's host.
- Callers outside React (Sonata's static `createOption`s) get the opener the way they already get
  the fetcher: `SourceContext` gains `openDialog`, bound by `useSourceCreators`. Module helpers
  (`openWallpaperPicker`, `openAddSourceDialog`, the file-explorer conflict dialog) become hooks or
  take the opener.

Rung: 1 for the renderable paths — a custom toast or a dialog has no spelling that does not
capture the caller's origin; 4 (loud runtime throw) for "a scope without an origin".

## Verification

- Unit (vitest): render-origin — raised content reads the origin's context, page fallback, scope
  without an origin throws, origin unmount runs `onGone`; toast — a custom toast raised under a
  context renders with that context's value inside the toaster, and its ledger/dismiss still work;
  imperative dialog — opens in the caller's origin, promise settles on close and on origin unmount.
- `./equin build`; demo e2e: no-leak (new step: raise a notification toast inside the demo, click
  its action, nothing reaches the page's server), app-switch, desktop-in-demo (wallpaper picker
  through the worker), prototypes-in-demo, sonata-in-demo, persistence.
- Real app: a toast (text and notification) and a confirm dialog still show and act as before.

## Outcome (2026-11-05)

- Implemented as designed. `RenderOrigin` closes a microtask after its unmount
  (`closeSoon`), so StrictMode's destroy → create keeps what a child raised from its
  own mount effect; an origin keys its store by the scope it is in, so a scope that
  changes in place ends what was raised in the old one (no throw).
- The demo has no notification toast with an action that a visitor can raise (every
  `useToast` with an action is a machine-only failure path), so no-leak's toast step
  uses the Pages "Page moved to trash" text toast and its Undo (the worker restores the
  page; nothing reaches the page's server). The renderable paths are pinned by unit
  tests (a custom toast reads its caller's context inside the toaster; a dialog renders
  in its caller's origin and settles when that origin goes) and by desktop-in-demo's new
  wallpaper step (an imperative dialog writing the scope's config, read back on reopen).
- e2e on the rebased build: no-leak 43 (2 host-skipped), app-switch 27,
  desktop-in-demo 22, prototypes-in-demo 27, sonata-in-demo 39, persistence 34. Real
  app: a notification toast and a report toast show stacked as before (measured
  heights, chrome theme), the Fix popover paints above the stack.
- Known, not changed: React synthetic events from raised content now bubble through
  the origin's tree (the embed) instead of from `Core.Root`; no handler on that path
  was found to misbehave.
