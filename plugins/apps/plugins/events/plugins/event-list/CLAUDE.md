# event-list

The Events app's main surface: every event, as a **live DataView**
(`defineDataView("events.list")`) over the `events.list` collection
(`core/internal/collection.ts`). The set grows without bound and the user
filters/sorts across all of it, so filter/sort/search compile to SQL per window
tuple, read as live key-range pages — the mail threads shape.

```
events-core: eventFields (labels, options, types)  →  eventsEntityRef
  ↓
core/internal/collection.ts   (liveCollection({ from: eventsEntityRef, pick }))
  ↓                                    ↓
web: DataView derives its fields   server/internal/collection.ts (serveCollection:
  (presentation: internal/              the source lookup + the default scopes)
   presentation.tsx)
```

Declared once, derived everywhere: each field — its label, type, options and
filter domain — is the `events` entity's (`events-core`'s `eventFields`). The
collection `pick`s which of them the list shows (`EVENT_LIST_PICK`, in list
order) and `EVENT_LIST_SORTABLE`; the row schema and the filterable columns are
derived from the picked fields, so the server and the DataView cannot drift on
which dimensions exist or what domain they filter in. The list's own code is
only `overrides`; the cells that are not a type's default (the absolute When,
the link chip) are presented once against the entity
(`FieldPresentation.Register({ owner: eventsEntityRef })`).

## Live, with no tick

The list is kept fresh by the routed change feed
(`research/2026-09-29-global-scoped-change-routing.md`, P4), never by a
revision tick and a refetch:

- an event write refills exactly that event in the segments that hold (or now
  admit) it; one no tuple's where / order reads (a title edit) reaches only the
  windows holding the event (`moves`);
- each row carries its source's ref (`sourceType` / `sourceConfig`, a REQUIRED
  lookup `source` on `events.source_id`), so a source write reaches the list
  through the lookup's REVERSE route, gated on the source columns the list reads
  (`id`, `type`, `config`, `enabled`): a run's `status` / watermark writes reach
  nothing; a type / config edit refills that source's events a tuple holds; an
  `enabled` flip refills its events (at most 500, then the window reloads,
  bounded);
- a deleted source's events arrive as event deletes (the FK cascade);
- the sighting stamps (`firstSeenAt` / `lastSeenAt`) are not on a listed event
  (`ListedEvent`), so a re-extraction that finds nothing new moves no row.

`e2e/list-live-verify.ts` drives each arm against a deploy.

## Every typed field is a filter AND a sort dimension

That is the whole reason this is a DataView. Adding a dimension means labelling
the field on the entity and picking it here (plus `EVENT_LIST_SORTABLE`, if it
sorts — only an index-backed column should) — **never** a hand `FieldDef`, a
bespoke toggle chip on the toolbar, or a hand-rolled `.map()` of `<Row>`
(`no-adhoc-row-list`). A few fields on purpose:

- **`sourceId` is picked with no presentation here.** Its options are the live
  sources, presented by the `sources/source-field` plugin
  (`FieldPresentation.Register({ owner: eventsEntityRef, fields: { sourceId:
  { useOptions } } })`) — only that plugin holds the live `event_sources` rows.
  Filter, sort and group compile to SQL on the raw id. This plugin names no
  source type, ever.
- **`tags` is a tags field** (the jsonb string array), filtered in the
  `stringArray` domain (has all / any / none of). It is not sortable: a jsonb
  array has no order.
- **`description` is listed but off the body** (`visible: false`): a search
  column must be a filterable text column, so it is a field — the search box
  lowers to `contains` over `EVENT_LIST_SEARCHABLE`. A tag is not searchable
  text (a live collection's filterable columns are row fields) — the Tags
  filter finds one.

`core/internal/fields.test.ts` pins the derived ids (saved views name them).

## Disappeared events, and a disabled source's, are hidden by DEFAULT

Both are the collection's `defaults` (`server/internal/collection.ts`, network/live's
default scopes): a predicate ANDed into a tuple unless its filter names the
column, with any op.

- **Disappearance is soft** (`disappearedAt` stamped, row never deleted), so
  those rows must not clutter an ordinary browse — but they must stay reachable,
  since a user may have annotated one. Naming `disappearedAt` is the view saying
  "I know about disappearance — here is what I want".
- **Disabling a source** is the user saying "I don't care about this any more",
  so its events stop cluttering the list — but nothing is deleted or stamped, so
  re-enabling the source brings every one of them straight back. Naming the
  `source` dimension ("source is X", "source is not empty") is asking about
  sources, a disabled one's events included.

The predicate is on the joined `event_sources` row, stated positively as "the
source is active" — never a denormalized `enabled` copy on the event row, which
would duplicate a *mutable* FK attribute across an unbounded table and owe a
backfill on every flip. The flip is routed instead (above).

## The gallery cover is an accessor, not a field

The poster comes from the `DataViewProps.cover` accessor in `web/panes.tsx`, not
from a cover field (`FieldDef.cover`) — `imageUrl` is deliberately not a field
(above). Don't mint one for the gallery: that adds a dead sort/filter
axis to every view to serve one view's chrome.

The src passes `externalUrl()` (absolute `http(s)` only — rows come from
untrusted scraped pages). The browser then loads it **directly from the event's
host**, unlike mail's `remote-images` proxy: an email image is an attacker-chosen
per-recipient tracking pixel, an event poster is a public asset on a site the
user configured. A same-origin proxy here would belong in a generic primitive,
not a copy of mail's app-scoped route.

## A row opens the event's page, else its source's

`onRowActivate` (host-level, so list/table/gallery agree) resolves
`event.url ?? source origin URL` through `externalUrl()`. The fallback is the
common case — an extraction often yields no per-event link — and it comes from
the source ref joined onto every row (`SourcedEvent`'s `sourceType` /
`sourceConfig`, read back by `sourceRefOf`), through `events-core`'s
`useEventSourceOrigin()`, whose answer each source type supplies via its
`originUrl`. No sources window is read, so an event of any source resolves, and
nothing is ever "not loaded yet". This plugin still names no source type. No
destination (hand-entered event) → the click is a no-op.

## Config is the only source of view instances

There is no code-synthesized default: the instances come only from
`config/apps/events/event-list/events.list.jsonc`, and
`config:overrides-authored` fails until its `// @review` marker is deleted. The
intended set is `Upcoming` (filter `startsAt is-on-or-after` today, sort
ascending), `All`, and `By category` (grouped). The surface is the collection's
`columnScope`, so its custom columns sort and filter server-side.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The events DataView: the live `events.list` collection (live key-range pages kept fresh by the routed change feed) rendered as list / table / gallery, its fields derived from the events entity (the absolute When cell and the link chip presented here) and the saved views authored in config. Reachable from the Events sidebar. Events DataView server: the `events.list` live collection over the events table joined to its source (a required lookup, routed in reverse: a source write refills that source's events, gated on the columns the list reads), with soft-deleted events and a disabled source's events hidden by default.
- Web:
  - Slots: `eventListPane.Actions`
  - Slot contributors: `eventListPane.Actions` ← `primitives.pane`
  - Contributes:
    - `Pane.Register` "event-list"
    - `Events.Sidebar` "Events"
    - `FieldPresentation.Register` "entity:events"
  - Uses:
    - `apps/events/events-core.useEventSourceOrigin`
    - `apps/events/shell.Events`
    - `network/live.FieldPresentation`
    - `primitives/css/badge.Badge`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/placeholder.Placeholder`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/data-view.DataView`
    - `primitives/data-view.defineDataView`
    - `primitives/data-view.fieldOverrides`
    - `primitives/data-view.liveDataSource`
    - `primitives/link-gesture/new-tab.newTabAnchorProps`
    - `primitives/link-gesture/new-tab.NewTabGlyph`
    - `primitives/pane.defineRoute`
    - `primitives/pane.Pane`
    - `primitives/pane.PaneChrome`
    - `ui/icons.Icon`
  - Exports (values):
    - `eventListPane`
    - `EventRow`
    - `useEventUrl`
    - `useOpenEvent`
- Server:
  - Contributes:
    - `resource.declare` "events.list"
    - `resource.declare` "events.list:groups"
    - `resource.declare` "events.list:rows"
  - Uses:
    - `apps/events/events-core._eventSources`
    - `apps/events/events-core.eventsTable`
    - `network/live.serveCollection`
  - Resources:
    - `events.list` (keyed, window)
    - `events.list:groups` (push)
    - `events.list:rows` (keyed, point)
- Core:
  - Uses:
    - `apps/events/events-core.EVENT_CATEGORIES`
    - `apps/events/events-core.EVENT_CATEGORY_META`
    - `apps/events/events-core.eventsEntityRef`
    - `apps/events/events-core.eventSourceFields`
    - `apps/events/events-core.SourcedEvent`
    - `fields/text/config.textField`
    - `network/live.liveCollection`
    - `network/live.LiveRowsCollection`
  - Exports (types): `EventListRow`
  - Exports (values):
    - `EVENT_CATEGORY_OPTIONS`
    - `EVENT_LIST_SEARCHABLE`
    - `eventsList`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --primary-text`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/type-scale --font-weight-medium`
  - Imported by: `apps/events/sources/source-detail/runs/extracted-events`

<!-- AUTOGENERATED:END -->
