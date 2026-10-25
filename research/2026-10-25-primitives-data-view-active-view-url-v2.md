# A DataView's active view, addressable from the URL — v2 (automatic)

Supersedes [v1](./2026-10-25-primitives-data-view-active-view-url.md), whose opt-in binding
(`viewParam={pane.keyedParam("view")}`) was rejected: if it is not automatic, it is too easy
to forget, and a surface that nobody bound is silently not addressable.

## Context

Same as v1. A DataView's active view lives only in localStorage (`useActiveViewId`), so:

- a link cannot open the Sonata library on its "All" table;
- the compare tool clicks view chips (`appSetup`) to reach a view.

**Goal:** the active view is in the URL (shareable, survives reload, drivable by e2e and
compare), and the per-device default is kept.

## Decisions

1. **`;view` is a reserved keyed param on every pane.** The router accepts a trailing
   `;view=<id>` on any pane's last URL part, without the pane declaring it. It is held in
   the slot's params, so history, reload and tab persistence carry it like any other param.
   - **No pane may declare `view` itself:** `defineRoute` throws on a declared `;view` or a
     `:view`. Sonata's player lens is renamed `;view` → `;lens`. An old `;view=notation`
     link now opens the default lens, which is the router's never-a-dead-link rule.
   - **A pane that declares no keyed params** strips only an exact trailing `;view=…`. Any
     other raw `;` stays text, as before.
   - **`view` is not part of a pane's typed params.** `useParams()` and `useResolve` never
     see it. It is read and written only through the binding below, through the URL, and
     through `useSetParams`, which preserves it.
2. **The landing pane can hold it too, as `/sonata;view=all`.** At an app's bare root the
   route is empty and the landing pane is synthesised by `useIndexMatch`, so it has no slot
   to hold the param. The store therefore keeps **index params** beside the slots: written
   to the URL as a suffix on the base path, saved in `history.state` (`{ route, index }`),
   read back on back/forward, and dropped by any navigation to a non-empty route. Readers of
   the base path accept `<base>;…`: `stripBasePath`, `appMatchesPath`, the pre-boot match.
   A nested empty-segment pane (no URL part of its own) cannot carry it, so its DataView
   stays device-local.
3. **Every DataView inside a pane binds automatically.** A new pane hook,
   `usePaneViewParam(claimant, name = "view")`, reads the enclosing instance from context
   and returns `{ value, set }`, or `null` when there is no pane, or the pane cannot carry
   the param.
   - `set` **replaces the history entry**: a view switch adds none.
   - **Each (instance, name) has one claimant.** A second DataView claiming the same name in
     the same pane instance throws. It must pass `viewParam="<other>"`, a keyed name its
     pane declares, or `viewParam={false}`, which keeps that DataView device-local (for a
     secondary list).
   - `pinnedView` hosts never bind.
4. **Resolution order:** pinned → **URL (if the id is authored)** → device-local → `defaultView`
   → first authored view.
   - Choosing a view writes both localStorage and the URL.
   - Adopting a URL id also writes it to localStorage. So if the URL later drops the param
     (opening a companion beside the landing pane, for example), the view on screen does not
     jump.
   - An id the config does not author falls through silently.

## Changes

- `pane/core/route.ts`:
  - `RESERVED_VIEW_PARAM`;
  - the keyed names used for matching and filling are the declared ones plus `view`;
  - `assertKeyedParams` rejects a declared `view`;
  - `fillSegment` writes the reserved param only for the slot's own segment;
  - `RouteDef.path` adds no `view`;
  - helpers to read and write the index suffix.
- `pane/web/pane.ts`:
  - `matchSegmentParts` changes as described in decision 1;
  - `parseUrl` returns `index`;
  - `buildRouteUrl` and `applyBasePath` write the index suffix;
  - the store gets index params with their serialization, restore and clearing, plus
    `setView(internal, instanceId, name, value)` (replace);
  - `setParams` preserves `view`;
  - `MatchEntry.params` omits `view`, and the entry exposes `view` instead;
  - `useIndexMatch` reads the index params;
  - new `usePaneViewParam`;
  - `stripBasePath` accepts `<base>;`.
- `apps-core` `appMatchesPath`, and the `web-core/App.tsx` pre-boot match, accept `<base>;`.
- `view-switcher` `useActiveViewId(storageKey, url?)`, view-core `resolveActiveId` and
  `useViewModel` (an `activeViewUrl` option), and data-view's `DataView`, `DataViewSwitcher`
  and `useDataViewModel` (a `viewParam` prop: `string | false`).
- Sonata player `;view` → `;lens`.
- Panes that render two DataViews at once get `viewParam` overrides.
- The compare `appSetup` view clicks become `;view=…` routes.
- Docs: the pane CLAUDE.md (reserved `;view` and index params) and the data-view CLAUDE.md
  (the state-split table, plus an "Addressable views" section).

## Verification

- Unit tests:
  - route round-trip with a reserved `view`, a declared-keyed pane, and a raw `;` as text;
  - index-suffix parse and build, including `/sonata;view=all`;
  - `setView` replaces the entry;
  - `useSetParams` preserves `view`;
  - `resolveActiveId` order;
  - a second claimant throws;
  - a jsdom test that a chip click rewrites the URL.
- Build, then take screenshots of `/sonata;view=all` (the All table) and of bare `/sonata`
  (the last view picked). Switching views changes the URL without adding history; reload
  keeps the view.
- Compare runs with no `appSetup` click.
- `./equin check`.
