# Op-status queue as a DataView (grouped compact table)

## Context

The banner above the prompt input (`plugins/conversations/plugins/conversation-view/plugins/op-status`) expands into a list of every in-flight op on the host. The list is drawn by `op-status-banner.tsx` with hand-written `.map()`s: one per kind section, then one per row. Ops are domain records, so they should render through `data-view`. As things stand the list gets no search, filter, sort, item actions or shared row chrome. It also slips past the `data-view/no-adhoc-row-list` lint, because that rule matches only a `.map` that returns `<Row>`.

The layout to keep is the "focus" direction of prototype `proto-1790774368-fg5s`:
- small uppercase section headers;
- in each row: a phase glyph, the push-queue position, the title, a "Held" label on held rows only, and two fixed `waited` / `worked` time columns;
- the column labels shown once, on the first section header;
- the current conversation's row highlighted.

**Which view.** The list is a table: labelled, fixed-width columns that line up across rows and sections. The list view is "title + subtitle + trailing" with no column tracks. Teaching it aligned, labelled columns would rebuild the table inside it. The table view already has column tracks, grouping and item actions. It lacks four things this surface needs:

1. A compact density.
2. Quiet group headers.
3. Column labels placed once, on the first group header, instead of in a sticky header row.
4. A way to keep a column unlabelled.

These four become generic table capabilities. That is the primitive change. The surface after it is a thin consumer.

## Part A: data-view table capabilities (primitive)

Files:
- `plugins/primitives/plugins/data-table/web/internal/{data-table.tsx,types.ts}`
- `plugins/primitives/plugins/data-view/plugins/table/{core/internal/types.ts,web/components/table-view.tsx}`
- `plugins/primitives/plugins/data-view/core/internal/types.ts`

1. **Column header placement.** Today `TableViewOptions` is an empty, reserved interface. Add:
   ```ts
   columnHeader?: "row" | "first-group"   // default "row" (today's sticky header row)
   ```
   - `DataTable` gains the matching `columnHeader` prop.
   - With `"first-group"` and groups present, there is no sticky header row. The first group header becomes a full-span subgrid row:
     - the group label spans the leading tracks, up to the first column that has a header;
     - each labelled column's header text sits in its own track, so it aligns with the cells by construction (same subgrid);
     - sort-on-click is kept.
   - Every other group header stays full-span.
   - Ungrouped, it falls back to `"row"`.
   - `groupHeaderTop` no longer adds a header height that isn't there.
2. **Unlabelled columns.** Add `FieldDef.header?: string | false`, which is the column header and defaults to `label`.
   - `false` leaves the header cell empty. The field keeps its `label` in the sort, filter and group pickers.
   - The table view maps `header: f.header === false ? "" : (f.header ?? f.label)`.
   - The first-group span rule reads "has a header".
3. **Compact density in the table.** Today `DataViewRenderProps.density` is documented as "table ignores it". The table view will pass it to `DataTable` as a `density` prop, which tightens the row block padding.
   - The row padding is the `py-row` token, so the implementation scopes the compact row-density token, not ad-hoc padding.
   - Update the doc comment that says the table ignores density.
4. **Quiet group headers in the table.** Honour `groupHeaders="quiet"`:
   - extract the quiet header rendering from `data-view/web/internal/grouped-sections.tsx` (lines ~120-160: semibold label, faint count, chevron on hover) into one shared internal component;
   - use that component from both `GroupedSections` and `table-view.tsx`;
   - update the `DataViewGroupHeaders` doc to say the table honours it.
5. **Tests** (jsdom), next to `table/web/__tests__/leading-field.test.tsx`:
   - `first-group` places labelled headers in the first group header and renders no header row;
   - a `header: false` column has an empty header but is still listed in the sort picker;
   - compact and quiet each change the rendered class or shape.
6. **Docs:** a short section in the data-view `CLAUDE.md` (table view options, `FieldDef.header`, density and quiet headers now honoured by the table).

Row tooltips stay out of the primitive: the op-status title cell wraps its own `WithTooltip`, so only that cell shows the tooltip, not the whole row.

## Part B: op-status banner on the table view

File: `plugins/conversations/plugins/conversation-view/plugins/op-status/web/components/op-status-banner.tsx`. Possibly a new `web/internal/queue-fields.tsx`.

- **Data.**
  - `buildSections()` in `web/internal/op-lines.ts` stays the authority for order: self-kind section first, global push-queue positions, and working → held → queued.
  - Flatten it to `QueueRow[]` in that order, and add `section: OpKind` to each row.
  - Pass the rows to `<DataView>` with `readiness` from `useOpsInFlight()`.
  - The default sort is `[]` (source order), so the queue order shows as built. A header click can re-sort; the positions stay the queue's.
- **Fields** (`FieldDef<QueueRow>[]`):

  | id | type / cell | header | width / align |
  |---|---|---|---|
  | `section` | enum; `options` built per render in section order; labels `Push queue` / `OP_KINDS[k].label`; `visible:false`, groupable | n/a | n/a |
  | `phase` | enum (working / queued / held), filterable; cell = `PhaseIcon` | `false` | `1rem` |
  | `pos` | number; cell = queue position or nothing | `false` | `1rem` end |
  | `title` | primary; conversation title from `useConversationTitleBySlug()`, else the slug (mono); "this conversation" tag on the self row; cell wrapped in `WithTooltip` (full `stateLine` + waited/worked split) | `false` | `minmax(0,1fr)` |
  | `held` | text; the `WAIT_KINDS[...].sentence(null)` warning label on held rows | `false` | `auto` |
  | `waited` | number ms; `TimeCell` (dash under 1 s, dimmed) | `waited` | `3rem` end |
  | `worked` | number ms; `TimeCell`, dimmed while queued | `worked` | `3rem` end |

  - Search: on title and slug.
  - The 1 s `useNow` tick re-derives the time values.
- **DataView props:**
  - `views={["table"]}`;
  - `storageKey = defineDataView("conversations.op-status.queue")`;
  - `density="compact"`;
  - `groupHeaders="quiet"`;
  - `viewOptions={{ table: { columnHeader: "first-group" } }}`;
  - `selectedRowId` = the self row's op id (gives the highlight);
  - `rowKey = r.row.opId`.
- **Actions.**
  - Activating a row opens the op detail pane: `openPane(opDetailPane, { opId }, { mode: "push" })`, with `opDetailPane` from `@plugins/debug/plugins/profiling/plugins/ops/web`. That pane reads any op, in flight included.
  - Item action "Open conversation" (`defineItemActions`) opens `conversationPane` with `row.conversationId`. It is hidden when that is null or the row is the current one.
  - Check there is no import cycle when wiring: `ops/web` imports `conversation-view/web`, not op-status.
- **Toolbar.** A hosted toolbar frame, declared at module scope, following `running-agents-band.tsx`, which passes its chrome through a `BandChromeContext`.
  - The frame is the whole banner card: the existing header button (state line, `+N others`, elapsed, chevron) and the body when expanded.
  - The DataView `options` trigger sits in the header row, only while expanded, so search, filter and sort cost no extra line.
  - The banner's op and `now` reach the frame through a context.
  - The collapsed header, the warning tone and `ResourceErrorInline` stay as they are.
- **Config.** One authored file, `config/conversations/conversation-view/op-status/conversations.op-status.queue.jsonc`, with a single table view: `groupBy: {fieldId:"section", groupingId:"value"}` and `sort: []`. Build seeds it; remove its `@review` marker after authoring.
- **Cleanup.** Delete `QueueRowView`, `SectionHeader` and both `.map()`s. Update the op-status `CLAUDE.md` "expanded list" paragraph.

## Out of scope / follow-up

`no-adhoc-row-list` matches only `.map → <Row>`, so this list was invisible to it. Widening the rule (for example `.map` returning any JSX over a live-collection read) is a separate lint change. I'll propose it as a task rather than fold it in here.

## Verification

1. `./equin test plugins/primitives/plugins/data-view/plugins/table` (new and existing table tests).
2. `./equin build`, which also runs the checks: type-check, eslint, boundaries, `config:overrides-authored`, and plugin docs in sync.
3. `./equin run plugins/conversations/plugins/conversation-view/plugins/op-status/e2e/op-status-waits.ts`. It asserts the banner text: `Build — held: host under duress (…)`, `requeue #2`, then `Build — Building`, plus the chip hourglass. The header line is unchanged, so it should pass as is.
4. Screenshot the expanded banner while ops are in flight. Use `screenshot.ts --path /agents/c/<id> --click "<state line>"`, in light and dark. Compare it with the prototype's focus/open state:
   - labels once on the first section header;
   - columns aligned across sections;
   - push positions present;
   - self row highlighted.

   Also check that clicking a row opens the op pane, and that the hover action opens the conversation.
5. Check that another table DataView (e.g. the Debug background catalog in table view) looks unchanged under the default `columnHeader: "row"`.
