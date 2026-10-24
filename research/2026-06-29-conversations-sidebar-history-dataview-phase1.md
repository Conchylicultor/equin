# Phase 1 — Sidebar History as a DataView

> Phase 1 of the conversations-sidebar → DataView migration. North-star map:
> [`research/2026-06-29-global-conversations-dataview-migration.md`](./2026-06-29-global-conversations-dataview-migration.md).
> Phase 0 (variant-region scaffold + `classic` variant) already landed.

## Context

The conversations sidebar list (Queue / Grouped / History tabs) is bespoke UI on
live-state. Phase 0 wrapped today's tabbed host as the `classic` variant of a new
**`sidebar-region`** (`defineVariantRegion`), with a `<Picker>` in the sidebar
header and a `<Region>` body that dispatches to the active variant. There is
currently only one variant (`classic`).

This phase adds the **first real `dataview` variant**: the sidebar's **History**
list rendered through the official **DataView** primitive, reusing the
**`all-conversations`** server-delegated query infrastructure
(`POST /api/conversations/query`, the revision-tick resource, the
`server-query` keyset compiler). It is the lowest-risk surface — pure
`created_at DESC` ordering, no rank/groups — and validates the whole variant
pipeline end-to-end (a `dataview` option appears in the picker; flipping to it
shows a working, server-paginated History; the `classic` fallback stays one
click away).

Scope note: in Phase 1 the `dataview` variant body is **just** the History list
(no Queue/Grouped yet — those are Phases 2–3). Flipping to `dataview` shows
History alone.

## Reuse surface (no duplication of data machinery)

All already live and registered by the `conversations` server plugin / the
`all-conversations` plugin — consumed via public barrels:

- `queryConversations` endpoint + `QueryConversationsBodySchema` — `@plugins/conversations/plugins/all-conversations/core`
- `conversationsRevisionResource` (push-mode change tick) — same core barrel
- `conversationFieldDefs` (web `FieldDef<Conversation>[]`) — `…/all-conversations/web` **(must be added to the barrel — see step 2)**
- `ConversationItem` row primitive — `@plugins/conversations/plugins/conversation-ui/plugins/item/web`
- `DataView`, `defineDataView`, `defineItemActions`, `fetchEndpoint` — DataView + endpoints primitives
- `SidebarRegion.Variant` + `ConversationSidebarProps` — the Phase 0 region barrels

The variant set is **open**: `SidebarRegion.Variant({ id, label, match, component })`
feeds a dynamic-enum; the picker discovers the new variant with **zero edits** to
`sidebar-region/core`.

## Design decisions

### 1. System conversations — included, optionally hidden by a filter preset

The `classic` History merges `active + system + recentGone` (so it **includes
system conversations**). The `queryConversations` handler hard-excludes them
(`ne(conversations.kind, "system")`). To keep the toggle faithful **and** make
hiding a user choice (not a baked-in scope), we:

- **Parameterize the endpoint** with an optional `includeSystem` (default
  `false`, so the `all-conversations` pane is byte-for-byte unchanged). When
  `true`, the handler drops the hard `kind != 'system'` predicate. The sidebar
  History passes `includeSystem: true`.
- **Ship an optional "Hide system" filter preset** in the sidebar's DataView
  config. `kind` is already a filterable enum `FieldDef`, so the preset is a
  plain saved `FilterGroup` (`kind is-none-of ["system"]`) applied via the
  filter pill — the DataView-native "filters are the extension point" path, no
  bespoke toggle. With the preset applied the SQL `compileWhere` adds the
  exclusion server-side; pagination just re-queries.

This leaves `all-conversations` untouched while giving the sidebar soft,
user-controllable system visibility.

### 2. Row rendering — reuse `ConversationItem` via the list view `renderRow`

Render each row through the shared `ConversationItem` (avatar, title, chips,
relative time) so the dataview rows match `classic` visually and inherit the
`Item.Chips`/`Item.Avatar` slot contributions for free:

- `views={["list"]}`, `viewOptions={{ list: { renderRow: (c) => <ConversationItem conv={c} layout="block" /> } }}`.
- Active highlight via `selectedRowId={activeId}` (the list view maps it to `bg-accent`).
- Navigation via `onRowActivate={(c) => onNavigate(c.id)}`.
- Close button via the list view's hover `itemActions` slot (sanctioned trailing
  affordance) — see "close handler" below.

The `conversationFieldDefs` schema still drives the toolbar (sort by `createdAt`,
filter by `kind`/`status`, full-text search); `renderRow` only owns the row body.

### 3. The DataView needs its own scroll container in the sidebar

The mount point renders `<Region>` inside `<Column … scrollBody={false}>`, so the
body does not scroll. `<DataView>` never owns a scroller and dev-asserts a scroll
ancestor exists. Wrap the DataView body in a `<Scroll axis="y" fill>`
(`@plugins/primitives/plugins/css/plugins/scroll/web`) — this provides the single
scroll ancestor the server-query `ScrollSentinel` + list virtualization bind to.

## Implementation steps

### 1. Parameterize the query endpoint (server, minimal)

- `…/all-conversations/core/internal/endpoints.ts`: add `includeSystem: z.boolean().optional()`
  (default treated as `false`) to `QueryConversationsBodySchema`.
- `…/all-conversations/server/internal/handle-query.ts`: replace the literal
  `ne(conversations.kind, "system")` term in the `and(...)` with
  `body.includeSystem ? undefined : ne(conversations.kind, "system")`
  (`and()` already drops `undefined` terms). Nothing else changes — sort, search,
  filter, keyset all stay.

### 2. Export the web field defs from the `all-conversations` barrel

- `…/all-conversations/web/index.ts`: add
  `export { conversationFieldDefs } from "./internal/fields";`
  (the "expose the data layer via public barrels" step — the new plugin consumes
  only barrels). The fields are host-agnostic; no logic moves.

### 3. New plugin `conversations-view/plugins/data-view/` (the `dataview` variant)

```
plugins/conversations/plugins/conversations-view/plugins/data-view/
  web/
    index.ts                        # default plugin: SidebarRegion.Variant(dataview) + item-actions/config contributions
    components/sidebar-history.tsx   # the variant body component
```

- `web/components/sidebar-history.tsx`:
  - Module-level `const SIDEBAR_HISTORY_VIEW = defineDataView("conversations-sidebar-history");`
  - Module-level `const HistoryItemActions = defineItemActions<Conversation>("conversations-sidebar-history-actions");`
    with a `CloseConvAction` contribution rendering a `RowActionButton`
    (`MdClose`) that calls the close handler from a small
    `CloseConversationContext` (see below).
  - `SidebarDataViewBody({ activeId, onNavigate, onCloseConversation }: ConversationSidebarProps)`:
    provides `onCloseConversation` via `CloseConversationContext.Provider`, then
    renders inside a `<Scroll axis="y" fill>`:
    ```tsx
    <DataView<Conversation>
      storageKey={SIDEBAR_HISTORY_VIEW}
      rows={[]}
      fields={conversationFieldDefs}
      rowKey={(c) => c.id}
      views={["list"]}
      selectedRowId={activeId ?? undefined}
      onRowActivate={(c) => onNavigate(c.id)}
      viewOptions={{ list: { renderRow: (c) => <ConversationItem conv={c} layout="block" /> } }}
      itemActions={HistoryItemActions}
      dataSource={{
        changeTick: matchResource(tick, { pending: () => null, ready: (d) => d.rev }),
        fetchPage: (args) =>
          fetchEndpoint(queryConversations, {}, { body: { ...args, includeSystem: true } }),
      }}
    />
    ```
    where `const tick = useResource(conversationsRevisionResource);`.
  - **Close handler threading**: `itemActions` components receive only `{ row }`,
    so the per-render `onCloseConversation` is supplied through a module-scoped
    React context (`CloseConversationContext`) provided by `SidebarDataViewBody`
    and read by `CloseConvAction`. (`activeId` needs no threading — it goes
    through `selectedRowId`.)
- `web/index.ts`: default plugin only —
  `contributions: [ SidebarRegion.Variant({ id: "dataview", label: "DataView", match: "dataview", component: SidebarDataViewBody }), CloseConvAction registration ]`.

### 4. Author the DataView config (required by the `data-view:configs-authored` check)

The check fails by default until each `defineDataView` id has a hand-authored
`config/<asPath(pluginId)>/<id>.jsonc`. Create (exact path is derived by codegen;
`./equin build` + the check will confirm it, expected
`config/conversations/conversations-view/data-view/conversations-sidebar-history.jsonc`):

```jsonc
{
  "views": [
    { "name": "History",
      "view": { "type": "list", "sort": [{ "fieldId": "createdAt", "direction": "desc" }] } }
  ],
  "filterPresets": [
    { "label": "Hide system",
      "group": { "kind": "group", "id": "hide-system", "conjunction": "and",
        "children": [
          { "kind": "rule", "id": "no-system", "fieldId": "kind",
            "operatorId": "is-none-of", "value": ["system"] }
        ] } }
  ]
}
```

(Preset row shape `{ label, group: FilterGroup }` per `presetsExtraFields` in
`data-view/shared/sort-presets-field.ts`; FilterGroup shape per
`config/tasks/task-list/tasks-list.jsonc`.) Run `./equin build` to
regenerate `shared/data-views.generated.ts` and the config `@hash`.

## Files to create / modify

| Action | Path |
|---|---|
| modify | `…/all-conversations/core/internal/endpoints.ts` (add `includeSystem`) |
| modify | `…/all-conversations/server/internal/handle-query.ts` (conditional kind exclusion) |
| modify | `…/all-conversations/web/index.ts` (export `conversationFieldDefs`) |
| create | `…/conversations-view/plugins/data-view/web/index.ts` |
| create | `…/conversations-view/plugins/data-view/web/components/sidebar-history.tsx` |
| create | `…/conversations-view/plugins/data-view/package.json` (copy a sibling, e.g. `classic/package.json`) |
| create | `config/…/data-view/conversations-sidebar-history.jsonc` (path confirmed by build) |

No edits to the mount point (`conversation-list.tsx`), `sidebar-region`, or
`classic` — the open variant registry means the new variant just appears.

## Verification

1. `./equin build` — must pass `data-view:configs-authored`,
   `data-views-in-sync`, `plugins-registry-in-sync`, `plugin-boundaries`,
   `type-check`. Open `http://att-1782744698-20pt.localhost:9000`.
2. Confirm the sidebar `<Picker>` now offers **Classic** and **DataView**.
3. Drive with `e2e/screenshot.mjs`: click the picker → **DataView**; capture the
   History list. Confirm: rows render as `ConversationItem` (avatar/title/chips/
   time), newest-first; the active conversation is highlighted; clicking a row
   navigates; the hover close button closes the conversation; scrolling fetches
   older pages (keyset cursor).
4. Compare data vs `classic` History against the same DB (flip the picker back
   and forth) — both should list the same conversations including system rows.
   Apply the **Hide system** filter preset and confirm system rows drop.
5. Cross-check with the `query_db` MCP tool: the DataView page count + ordering
   matches `SELECT … FROM conversations_v ORDER BY created_at DESC` (with/without
   `kind != 'system'`).
6. Confirm the `all-conversations` pane (sidebar "Conversation" entry) is
   unchanged — system conversations still absent there (`includeSystem` defaults
   to false).

## Caveats / risks

- **Close-handler-via-context** is the one non-obvious wiring (module-level
  `itemActions` descriptor vs per-render handler). If it feels heavy, an
  acceptable Phase-1 fallback is rendering the close button inside `renderRow`
  using the `row-actions` primitive — but the `itemActions` slot is the
  sanctioned trailing-action home, so prefer the context.
- **Config path**: the exact `config/.../*.jsonc` directory is derived from the
  defining plugin id by codegen; trust the build/check output over the guessed
  path above.
- **No Queue/Grouped in `dataview` yet** — flipping to DataView intentionally
  shows only History this phase. Make this obvious in the variant label if
  needed (kept as plain "DataView" for now).
