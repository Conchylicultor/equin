# A DataView's active view, addressable from the URL

## Context

A DataView's active view is stored only on the device: `useActiveViewId(storageKey)` keeps
it in localStorage (`view-switcher.active-view`). It is read once on mount and resolved by
view-core's `resolveActiveId`, in the order persisted → `defaultView` → first authored. So:

- a link cannot open Sonata's library on its **All** table;
- a reload in a new tab, or a shared URL, opens whatever view that device used last;
- tooling has to click its way to a view. The compare tool's metrics diff carries `appSetup`
  steps for this: `"click": "[data-part~=\"dv.view-chip\"][aria-label=\"Recently edited\"]"`
  in `prototypes/gallery/e2e/proto-…-9zh04x.parts.json` and `sonata/library/e2e/proto-…-4bakda.parts.json`.

**Goal:** the active view becomes part of the pane's address, so it is shareable, survives
reload and can be driven by e2e and compare. The per-device default stays: a URL that names
no view behaves exactly as it does today.

## Decisions (agreed)

- **The carrier is the pane's keyed matrix param, `;view=<id>`.** The router already has it
  for "a view of what the pane shows" (Sonata's player is at `song/:songId;bar;view`). It is
  scoped to its pane, so a multi-column URL has no ambiguity. It already lives in the
  pane-store snapshot that history, tabs and AppEmbed carry. A global `?query` was rejected:
  the pane store drops it on every commit, and it is not in history snapshots.
- **Switching views replaces the URL in place.** The address bar always shows the current
  view, and a view switch adds no history entry.
- The view id is the one that already exists: the slug of the config row's name, or its
  explicit `id`. For example `all`, `recently-edited`.

## Design

### 1. The pane primitive: a typed, bindable keyed param (`plugins/primitives/plugins/pane`)

- **`pane.keyedParam(name)`** is a new `PaneObject` method. It returns a `PaneKeyedParam`
  value `{ pane, name }`, and `name` is typed as the union of the keyed names in the pane's
  `segment` (a template-literal parse, next to the existing segment param typing). If the
  pane does not declare `;view`, `pane.keyedParam("view")` is a **tsc error** (rung 2).
- **`usePaneKeyedParam(binding)`** is a new free hook in `pane/web`. It returns
  `{ value: string | undefined, set(v: string | undefined) }`. It reads the enclosing
  instance from `PaneInstanceContext`, which `pane.ts:2036` already exports, and **throws**
  if that instance is not `binding.pane` (rung 4: a binding handed to a component outside
  its pane). `set` goes through `store.setParams`, which keeps the instance's other own
  params.
- **`store.setParams(…, { replace?: true })`**: today it always follows
  `!chrome.history` (`pane.ts:1172-1193`). This adds an opt-in replace that the binding
  uses. `useSetParams` gains the same option, so the two cannot differ.
- **Keyed params on an app-index pane** (empty `segment`). `assertKeyedParams`
  (`core/route.ts:280`) rejects keyed params on a segment with no URL part of its own, but
  both motivating surfaces are app-index panes at a bare base path. The suffix will sit on
  the base path, `/sonata;view=all`, and this is allowed **only for a parentless root pane**.
  A root's preceding part is the base path, so there is no ambiguity. A nested empty-segment
  pane keeps the throw. This needs:
  - `stripBasePath` (`pane.ts:2135`) and `appMatchesPath` (`apps-core/web/internal/resolve-app.ts`)
    to accept `bp + ";"` as a match, mapping it to the route path `/;view=all`;
  - `matchSegmentParts` / `fillSegment` to read and write the keyed suffix of an empty
    segment as a part with an empty base;
  - the URL builder to emit `<base>;k=v`, not `<base>/;k=v`.

  If this proves invasive during implementation, the fallback is `/sonata/;view=all`, which
  needs no base-path change. Update the pane CLAUDE.md keyed-param section with whichever
  ships.

### 2. Active-id resolution: URL first, then device (`primitives/view-switcher`, `data-view/view-core`)

- `useActiveViewId(storageKey, url?: { value; set })`:
  - **read:** `url.value` is passed to the resolver as a separate, higher-priority input. It
    does not overwrite storage.
  - **select:** `setActiveView(id)` still writes localStorage, which is the per-device
    default, so a bare link opens the view last picked on this device. When bound, it also
    calls `url.set(id)`.
  - It always writes the id explicitly, even when the id is this device's default, because
    a shared link must name the view.
- `resolveActiveId(instances, fromUrl, persisted, defaultView, pinned)` resolves in the
  order pinned → **URL (if authored)** → persisted → default → first. A URL naming an
  unauthored id falls through silently. That matches the router's rule that an undeclared
  key shows the default view and is never a dead link. Extend `resolve-active-id.test.ts`.
- `useViewModel(..., opts.activeViewUrl?)` threads the binding into `useActiveViewId`. The
  `addView`, `duplicateView` and `saveAsNew` paths already call `setActiveView`, so a new
  view lands in the URL with no extra work.
- `tabbed-view` (`define-tabbed-view.tsx:44`) gets the same optional binding. It adopts
  nothing now, but uses the same hook.

### 3. DataView API (`primitives/data-view`)

- `DataViewProps.viewParam?: PaneKeyedParam` and the same on `DataViewSwitcherBaseProps`.
  `DataView` calls `usePaneKeyedParam(viewParam)` (conditionally, through a small wrapper
  component, or with a no-op binding, so hook order stays stable) and passes it to
  `useDataViewModel`.
- `viewParam` together with `pinnedView` is a tsc error (a discriminated union of the two
  props). A pinned host is deliberately outside the surface's shared selection.
- Two DataViews in one pane each bind their own name, for example `;queue;history` in
  `debug/queue/jobs-view.tsx`. A DataView outside a pane (menu bar, popovers, sidebars,
  dialogs) cannot pass a binding, so it stays device-local. Those are chrome, not
  addressable content.
- Document it in `data-view/CLAUDE.md` in two places: the state-split table ("Active
  instance id: URL `;<param>` when bound, else localStorage") and a short "Addressable
  views" section.

### 4. Adoption (this change)

- Sonata library: `sonataLibraryPane` gets segment `";view"` and
  `viewParam={sonataLibraryPane.keyedParam("view")}`. It is passed down to `SongLibrary`
  (`song-library.tsx:158`), so `/sonata;view=all` opens the All table.
- Prototypes gallery: the same, on its root route (`prototypes/shell/core/routes.ts:15`)
  and `PrototypeGallery`.
- Compare tool: drop the two `appSetup` view-chip clicks, and point those mocks' routes at
  `;view=recently-edited` (or whatever the mock's view ids are). `appSetup` stays for
  non-view setup, and its CLAUDE.md example changes to a non-view click.
- Wider adoption, every pane-hosted DataView, is a **follow-up task**, not this change.
  A lint rule ("a `<DataView>` rendered by a `Pane.define` component passes `viewParam`") is
  a candidate for that task.

## Critical files

- `plugins/primitives/plugins/pane/core/route.ts`: keyed-name typing, `assertKeyedParams`,
  `fillSegment`
- `plugins/primitives/plugins/pane/web/pane.ts`: `keyedParam`, `usePaneKeyedParam`,
  `setParams` replace, `matchSegmentParts`, `stripBasePath`
- `plugins/apps-core/web/internal/resolve-app.ts`: base-path match with `;`
- `plugins/primitives/plugins/view-switcher/web/internal/use-active-view.ts`
- `plugins/primitives/plugins/data-view/plugins/view-core/web/internal/{resolve-active-id,use-view-model}.ts`
- `plugins/primitives/plugins/data-view/web/components/{data-view,data-view-switcher}.tsx`,
  `web/internal/use-data-view-model.ts`
- Sonata `library/web/panes.tsx` and `song-library.tsx`, the prototypes shell routes and
  the gallery, and the two `*.parts.json` files

## Verification

- Unit tests (`./equin test plugins/primitives/plugins/pane plugins/primitives/plugins/data-view`):
  - route round-trip for `;view` on a root empty segment;
  - a `;` base-path match;
  - `setParams` replace;
  - `resolveActiveId` order (URL > persisted > default; an unauthored URL falls through;
    pinned beats URL);
  - a jsdom test that a chip click rewrites the URL with `replaceState` and still writes
    localStorage.
- `./equin build`, then:
  - `screenshot.ts --path "/sonata;view=all"` shows the All table on a fresh browser
    profile;
  - bare `/sonata` shows the last-picked view;
  - clicking Cards changes the address bar to `;view=cards` and Back does not step through
    views;
  - reload keeps the view.
- `compare-diff.ts --name <the two protos>` runs with no `appSetup` click and gives the same
  differing-pixel ratio as before.
- `./equin check` (type-check, pane segment checks, docs in sync).
