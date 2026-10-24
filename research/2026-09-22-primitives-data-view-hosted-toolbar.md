# DataView without its toolbar band — the host places the options trigger

## Context

Every `<DataView>` draws a sticky toolbar band (switcher, search, filter, sort,
fields) above its rows, and nothing turns it off. Even `density="compact"` leaves
a ~36px strip holding one hover-revealed options button. Small fixed lists inside
other chrome pay for this with a strip that mostly does nothing.

Prompting case: the running sub-agents band above a conversation's prompt box
(1–4 live agent rows in a small card). The `no-adhoc-row-list` rule says those
rows must be a DataView; a toolbar band there is noise.

Why the existing seams can't express it:
- `ToolbarArrangement` (`core/internal/toolbar-arrangement.ts`) requires every
  layout to render the switcher and the search field, so an empty arrangement
  breaks its contract.
- Below 360px (or `density="compact"`) `DataViewToolbar` takes the compact
  branch, which ignores the arrangement entirely.

**Decided with the user:**
- The controls stay reachable through **one options trigger that the embedding
  surface places in its own chrome** (e.g. the card's title row). It is the same
  panel the compact fold opens today, with a count badge while anything narrows
  the list.
- **Config is unchanged.** A hosted-toolbar DataView keeps its `defineDataView`
  id and its authored config file, exactly as today.

## Design

### API — a second toolbar kind, not a degenerate arrangement

`DataViewProps.toolbar` becomes a union:

```ts
toolbar?: ToolbarArrangement | HostedToolbar;

/** No band: the surface draws its own frame and places the options trigger. */
export interface HostedToolbar {
  kind: "hosted";
  frame: ComponentType<HostedToolbarParts>;
}
export interface HostedToolbarParts {
  /** The options trigger (search + every control + view switcher when >1
   *  views). Render it exactly once, somewhere the user can reach. */
  options: ReactNode;
  /** DataViewProps.creators, built in the compact form; null when none. */
  creators: ReactNode;
  /** The rows (loading skeleton / placeholder / active view). */
  body: ReactNode;
}
```

Why a frame component (render-prop) rather than a portal target or a ref:
- The trigger stays inside the DataView's React tree, so it reads
  `useDataViewControls()` with no context bridging and no "target not mounted
  yet" state.
- The frame is the host's card: title row with `options` on the right, `body`
  below. Placing the trigger is the frame's whole job, so forgetting it is
  visible in the one component that exists for it.
- `ToolbarArrangement` keeps its contract untouched. `kind: "hosted"` is
  discriminated from arrangements (which have `id`/`forms`/`component`).

`title` and `actions` are not passed to the frame: a hosted surface owns its own
header, so it renders them itself. Passing `title`/`actions` together with a
hosted toolbar is a type error (discriminated `DataViewProps` chrome fields, or a
dev throw if the union gets too heavy — decide at implementation, prefer the
type).

### Behaviour

- **No band, no sticky, no measurement.** The shell publishes
  `--dv-header-offset: 0px`, so grouped views' sticky headers pin to the top.
- **Trigger** = `CompactControls` with `search` included, `form="ghost"`.
  Hover-revealed off the DataView root (the root carries `hoverRevealGroup` in
  hosted mode, and the frame renders inside the root, so pointing anywhere at
  the card brings it back). The existing reveal suspension keeps it visible while
  a query is typed or the panel is open, and the badge counts active
  filters/sorts + query — a narrowed list never reads as complete.
- **View switcher** moves into the panel's first page (the collapsed switcher
  chip, only when `switcherCount > 1`), so adding/switching views stays
  reachable. Pinned surfaces show none, as today.
- **Loading / no-views branches** (`ShellToolbar` today) render through the same
  frame, with `options: null`, so the card doesn't reflow as config settles.
- `density` still governs row rhythm; it no longer has anything to fold.

### Code changes

- `core/internal/toolbar-arrangement.ts` — add `HostedToolbar`,
  `HostedToolbarParts`; export from `core/index.ts`.
- `core/internal/types.ts` — `DataViewProps.toolbar` union; doc comment.
- `web/components/toolbar/data-view-toolbar.tsx` — extract the shared
  derivation (applicable/ordered controls, `activeCount`, search input) into a
  small internal hook so the band and the hosted trigger compute them once, the
  same way.
- New `web/components/toolbar/hosted-toolbar.tsx` — builds `options` and
  `creators` for the frame.
- `web/components/toolbar/compact-controls.tsx` — optional `switcher` node on
  the first page (above search).
- `web/components/data-view-body.tsx` — branch on `chrome.toolbar.kind`:
  band → `DataViewToolbar` as today; hosted → render `frame` with the body
  (view render + infinite-scroll footer) as `body`.
- `web/components/data-view.tsx` (`DataViewShellFrame`, shared with
  `MergedDataView`) — skip toolbar measurement, set the hover group, route the
  loading/placeholder branches through the frame.
- `web/internal/body-types.ts` — `DataViewShellChrome.toolbar` type.
- `CLAUDE.md` (data-view) — a "Hosted toolbar" section: when to use it (small
  embedded lists in someone else's chrome), the frame contract, and that config
  is unchanged.

No change to `defineDataView`, config descriptors, or the
`config:overrides-authored` check.

### First consumer

The running sub-agents band (its own task/plan,
`research/2026-09-22-conversations-running-subagents-band.md`) adopts
`toolbar={{ kind: "hosted", frame: SubagentsCard }}` with a `list` view config.
Not part of this change; this change ships the primitive plus tests.

## Verification

- `./equin test plugins/primitives/plugins/data-view` — new cases in
  `web/__tests__/` (pattern: `toolbar-arrangement.test.tsx`):
  - hosted frame receives `options`/`body`; no sticky band is rendered;
  - opening `options` shows search + applicable controls, and the switcher only
    when >1 instances (none when pinned);
  - badge counts an active filter and a non-empty query;
  - loading and no-views branches render through the frame with `options: null`.
- `./equin check type-check` (and full `check` via build).
- `./equin build`, then temporarily switch one small existing DataView
  (e.g. `plugins/build/web/components/build-popover-content.tsx`) to a hosted
  frame locally, screenshot with the e2e `screenshot.ts --click` on the trigger
  to confirm the panel opens and filters apply; revert before review.
