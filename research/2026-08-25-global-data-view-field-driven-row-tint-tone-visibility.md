# DataView: a field-driven row can say what a hand-written one says

**Date:** 2026-08-25
**Category:** global (primitive: `primitives/data-view` + `fields/enum`, `fields/tags`, `primitives/css/badge`; first customer: `apps/events/sources`)

## Context

The list view builds a row from the `FieldDef` schema — primary field as the title,
`align:"end"` fields trailing, the rest as a `·`-joined muted subtitle — and since
[`2026-08-19-global-data-view-compact-chrome-and-single-line-list.md`](./2026-08-19-global-data-view-compact-chrome-and-single-line-list.md)
that row is one line by default.

The Events sources list does not look one line, which is what prompted this. It
passes `viewOptions.list.renderRow` and draws its own two-line row, so the default
never applies. That row predates the default by two weeks (`25b54e884`, 2026-08-04).

The obvious follow-up — "delete the row overrides" — turns out to be mostly wrong,
and knowing why is the point of this plan. An audit of all nine `renderRow` call
sites found that **none of them is only working around a missing knob.** Every one
carries something a field schema cannot express:

- **Content that is deliberately not a field.** `MailThread`'s own field file says
  so (`plugins/apps/plugins/mail/plugins/threads/core/internal/fields.ts:6-9`):
  sender and snippet are excluded to avoid dead sort axes. Same for quick-theme's
  `cssVars` and the conversation row's `spawnedBy`.
- **Cross-plugin slots inside the row body.** `ConversationItem` renders
  `Item.Chips` and `Item.Avatar`, into which other plugins contribute. No static
  `FieldDef[]` represents that.
- **A bool rendered as a conditional icon** — EventRow's `recurring`, ThreadRow's
  `important` / `hasAttachments`.
- **Layout ranked by importance** rather than primary-plus-joined-rest — EventRow
  keeps `startsAt` on the title line; RunRow leads with the outcome badge and
  demotes its own primary field.
- **Per-field truncation escapes** — deploy history renders a failure message
  untruncated and wrapping, only on failure, and its doc comment names the joined
  subtitle as exactly what it is escaping.

So `renderRow` is doing its job, and this plan does **not** try to retire it.

What the audit does establish is that three capabilities are missing from the
field-driven row, and the payoff is not the nine overrides — it is the **~25
consumers already using the default** (Debug → Reports, slow-ops, workflow
executions, deploy servers, agent launches, build history, config-orphans,
backlinks, studio compositions, …). Today those lists cannot tint a status, cannot
dim an inactive row, and cannot declare a field filter-only.

Evidence each gap is real and recurring:

| Gap | Evidence |
| --- | --- |
| **Tint** — an enum's `options` carry `{value,label}`, and `EnumCell` renders `<Badge variant="muted">` unconditionally | The label-map + variant-map pair is hand-written six times: `SOURCE_STATUS_VARIANT`, `EXTRACTION_STATUS_VARIANT`, `RUN_OUTCOME_VARIANT`, `ACTION_VARIANT` (Events), `KIND_VARIANT` (trace), `SEVERITY_VARIANT` (timeline). 131 hand-written `cell:` functions repo-wide. |
| **Tone** — no per-row emphasis | `SourceRow` mutes a disabled source; `ConversationItem` mutes `gone`/`done` and dims `working`; `ThreadRow` bolds unread. Three plugins, one idea, no primitive. |
| **Visibility** — a field is printed iff it is declared | Fields declared but never printed already: mail's `labels`/`messageCount`, event-list's `tags`/`url`/`disappearedAt`, conversations' `model`/`runtime`/`worktreePath`/`endedAt`, quick-theme's `tags`. Every one of those lists reaches `renderRow` partly to get this. |

**Outcome:** the three capabilities land in the primitive, Events sources becomes
the proof by deleting `SourceRow` entirely, and the other eight overrides are left
alone.

## The end-user experience

The whole Events sources list, after:

```tsx
<DataView<EventSource>
  storageKey={SOURCES_VIEW}
  rows={sources}
  fields={fields}
  rowKey={(s) => s.id}
  rowTone={(s) => (s.enabled ? "default" : "muted")}
  views={["list", "table"]}
  /* … creators / itemActions / onRowActivate unchanged … */
/>
```

No `renderRow`. No `SourceRow`. The row renders

```
Meetup Paris · Web page · Daily · [Failed]                        5m ago
```

and a disabled source renders the same line dimmed. `Failed` is red, `Running`
blue, `Disabled` grey — because the option said so, not because a row component
looked it up.

## Design

### 1. An enum option carries its display metadata

`FieldDef.options` (`data-view/core/internal/types.ts:277`) becomes:

```ts
options?: {
  value: string;
  label: string;
  /** Chip tint for the read cell. Default "muted". */
  variant?: BadgeVariant;
  /** Tooltip on the chip — why this value means what it means. */
  hint?: string;
}[];
```

`hint` is in scope rather than deferred because dropping it would regress the
Events conversion: `EXTRACTION_STATUS_HINT` (`sources/web/internal/format.ts:98`)
is what tells a reader that `Empty` means "the run succeeded and found nothing".
One idea — *an option describes how it presents* — not two.

**`BadgeVariant` has to become reachable from `core`.** It lives at
`primitives/css/badge/web/internal/badge.tsx:10`, badge has no `core/` barrel, and
`boundary-config.ts` maps `core: ["core"]` — a `core → web` edge is denied. Mint
`primitives/css/badge/core` exporting the `BadgeVariant` union (the
`VARIANT_CLASS` map stays in `web`), and re-export it from `badge/web` so no
existing import breaks. Duplicating the union into data-view/core is the
alternative and is rejected: one name per concept.

Two read cells learn the key — both currently hardcode `variant="muted"` off the
same `{value,label}` contract:

```tsx
// fields/enum/plugins/table/web/components/enum-cell.tsx:12  (and the tags twin)
const option = props.field.options?.find((o) => o.value === raw);
return <Badge variant={option?.variant ?? "muted"} title={option?.hint}>
         {option?.label ?? raw}
       </Badge>;
```

**Deliberate no-ops** (state them, don't fix them): the inline editors and the
filter operand input render `ToggleChip`, not `Badge` — `enum-editor.tsx`,
`tags-editor.tsx`, `chip-select-filter-input.tsx` keep their current look, because
`BadgeVariant` is not `ToggleChip`'s vocabulary. Group-by section labels and
`summarize-filter` are text-only and pass through untouched. Server-side filter SQL
never reads `label`/`options` at all, so the tint never reaches the server.

**Custom columns round-trip for free.** `deriveEnumFieldDef`
(`fields/enum/plugins/column-config/web/internal/enum-config.ts:22`) forwards the
whole option object opaquely and `CustomColumnDef.config` is persisted unvalidated,
so widening `EnumOption` with the two keys is the only change. `EnumOptionsEditor`
is **not** given a colour picker in this pass — user-authored custom columns stay
muted, which is the right default for a column whose values have no semantics.

`dynamic-enum` is unaffected: it has no table/inline/filter sub-plugins and never
reads `field.options` (its own `CLAUDE.md:7-9` says why).

### 2. `rowTone` — a row can read as inactive

```ts
// data-view/core/internal/types.ts
export type RowTone = "default" | "muted";

export interface DataViewProps<TRow> {
  /** Per-row emphasis. "muted" dims the row's own text, so a switched-off /
   *  archived / finished row reads inactive without spending a chip on it. */
  rowTone?: (row: TRow) => RowTone;
}
```

`RowTone` is declared locally rather than reusing `TextTone` (`css/text` also has
no `core` barrel, and only two of its four tones mean anything for a row).

**It threads like `searchAccessor`, not like `density`.** `density` is a
declaration *about the surface*, so it travels `DataViewProps → DataViewShellFrame
→ DataViewShellChrome → DataViewBody`. `rowTone` is a *data accessor* closed over
row identity, the same shape as `searchAccessor` / `onRowActivate` / `hierarchy`,
which flow straight through `DataViewSourceBundle → DataViewBodyProps →
renderProps` with no chrome hop. Concretely this means **no** change to
`body-types.ts`, `data-view.tsx` or `merged-data-view.tsx` — only the two type
declarations, one destructure-and-forward line in `DataViewBodyInner`
(`data-view-body.tsx`, beside `searchAccessor`), and the two barrel exports.

Applied per view at the sites the plumbing trace named:

| View | Where |
| --- | --- |
| list | the title `<Text>` at `list-view.tsx:~296` (one-line) and `~247` (stacked) — `tone` instead of the hardcoded `text-foreground` |
| gallery | the card title `<Text>` at `gallery-view.tsx:~244` |
| tree | `labelClass` at `tree-view.tsx:84` — already the per-row style hook (`options.labelClassName`); `rowTone` composes with it |
| table | **deliberate no-op.** Its only per-row seam is `DataTableProps.useRowDecoration`, a single slot already held by manual-order drag decoration. Merging two decorations is its own change. |

The tree's existing `labelClassName` / `rowAccent` stay as the escape hatch;
`rowTone` is the semantic form a consumer should reach for first.

### 3. `FieldDef.visible` — a field can be a dimension without being printed

```ts
/** Whether the field is in the DEFAULT body set (list subtitle, table column,
 *  gallery property). Default true. `false` = it feeds sort / filter / group /
 *  search only; the user can still switch it on in Properties. */
visible?: boolean;
```

Two places hardcode "show everything" and both must read it — this is the part
easy to half-do:

```ts
// web/internal/resolve-body-fields.ts:19   (the unconfigured branch)
if (visible == null) return fields.filter((f) => f.visible !== false);

// web/internal/use-visible-fields-controller.ts:51-53
if (visibleFields == null) {
  return fields.map((field) => ({ field, visible: field.visible !== false }));
}
```

Sort / filter / search are unaffected by construction: all four views call
`resolveBodyFields` *after* `useDataViewSections` has already run over the full
`props.fields` (verified at `list-view.tsx:130-140`, `table-view.tsx:81-172`,
`gallery-view.tsx:130-141`, `tree-view.tsx:207-302`).

**The one semantic to accept and document:** in a view whose config already holds
an explicit `visibleFields` array, a `visible:false` field is indistinguishable
from "a field the user never switched on" — the array simply does not mention it.
That is existing, intended Notion-parity behaviour ("once customized, later-added
fields stay hidden until toggled on"), and it means `visible` is a *default*, not
an enforcement. Fine for Events sources: none of its three views author
`visibleFields` (`config/apps/events/sources/events.sources.jsonc`).

Custom columns need nothing — they are folded into `props.fields` before any view
calls `resolveBodyFields`, and an absent `visible` reads as `true`.

### 4. The subtitle separator stops middot-ing chips

This is required by the conversion, not cosmetic garnish. `type` and `refresh` are
both `type:"enum"`, so today's field-driven row would already render
`name · [Web page] · [Daily] · [Failed]` — three chips strung on middots, which is
worse than the two-line row it replaces.

The list must know which terms render as chips, generically. The `DataViewSlots.Cell`
contribution is already per-field-type and already consulted by the list through
`resolveCell`, so it is the right carrier:

```ts
DataViewSlots.Cell({ match: "enum", component: EnumCell, chip: true })
DataViewSlots.Cell({ match: "tags", component: TagsCell, chip: true })
```

The list draws ` · ` only **between two adjacent non-chip terms**; a chip is
separated by spacing alone. No new slot, and the list names no field type — it asks
the registry, per the collection-consumer rule. `resolveCell` gains a sibling that
answers "is this field's cell a chip", or returns the contribution rather than just
the component.

Read the `css` SKILL before touching the subtitle run — this is the
containers-share-space / leaves-truncate model, and the chip terms are rigid leaves.

### 5. Events sources: delete the hand-written row

`sourceState()` moves **into `events-core/core`, beside `extractionStatus()`** —
it is derived domain logic over an `EventSource`, and that is where the sibling
derivation already lives. It states the precedence the row currently states inline
(`source-row.tsx:64-121`), unchanged:

```ts
/** Disabled beats Running beats the last extraction's verdict. A switched-off
 *  source's extraction status is a fact about the past. */
export function sourceState(s: EventSource): SourceState {
  if (!s.enabled) return "disabled";
  if (s.status === "running") return "running";
  return extractionStatus(s);          // never / ok / empty / failed
}
```

In `sources-list.tsx`:

```ts
// before                                  // after
{ id: "status",     … },                   { id: "status",     …, visible: false },
{ id: "extraction", … },                   { id: "extraction", …, visible: false },
{ id: "enabled",    … },                   { id: "enabled",    …, visible: false },
                                           { id: "state", label: "State", type: "enum",
                                             options: SOURCE_STATE_OPTIONS,
                                             value: (s) => sourceState(s) },
```

and `internal/format.ts` folds each variant map into its options array, so the pair
that had to be joined by hand at every render site becomes one list:

```ts
// before — two parallel maps
export const SOURCE_STATUS_OPTIONS = SOURCE_STATUSES.map((s) => ({ value: s, label: SOURCE_STATUS_LABEL[s] }));
export const SOURCE_STATUS_VARIANT: Record<SourceStatus, BadgeVariant> = { idle: "muted", running: "info", error: "destructive" };

// after — one
export const SOURCE_STATUS_OPTIONS = SOURCE_STATUSES.map((s) => ({
  value: s, label: SOURCE_STATUS_LABEL[s], variant: SOURCE_STATUS_VARIANT[s],
}));
```

`SOURCE_STATUS_VARIANT` / `EXTRACTION_STATUS_VARIANT` stay exported — the source
detail pane (`source-detail/plugins/status`) still reads them directly.

**One thing does not survive as a pure option list:** the `type: shotgun (not
installed)` fallback (`source-row.tsx:32-35`). The `type` field's options come from
the live registry, so an uninstalled type's value has no option and `EnumCell`
falls back to the raw id. Keep it with a small `cell` on the `type` field alone —
a per-field cell is the sanctioned escape, unlike a whole-row override.

Then delete `source-row.tsx` and the `renderRow` line.

## Files

**`primitives/css/badge/`**

| File | Change |
| --- | --- |
| `core/index.ts` *(new)* | export the `BadgeVariant` union |
| `web/internal/badge.tsx`, `web/index.ts` | import + re-export it from `core` (no call-site churn) |

**`primitives/data-view/`**

| File | Change |
| --- | --- |
| `core/internal/types.ts` | `options` gains `variant`/`hint`; `FieldDef.visible`; `RowTone`; `rowTone` on `DataViewProps` + `DataViewRenderProps` |
| `core/index.ts`, `web/index.ts` | export `RowTone` |
| `web/components/data-view-body.tsx` | destructure + forward `rowTone` onto `renderProps` (beside `searchAccessor`) |
| `web/internal/resolve-body-fields.ts` | identity branch filters `visible !== false` |
| `web/internal/use-visible-fields-controller.ts` | unconfigured branch seeds from `field.visible` |
| `web/cell-slot.ts` | `chip?: boolean` on the Cell contribution; expose it to the list |
| `plugins/list/web/components/list-view.tsx` | title honours `rowTone`; subtitle separator skips chip terms |
| `plugins/gallery/web/components/gallery-view.tsx`, `plugins/tree/web/components/tree-view.tsx` | title honours `rowTone` |
| `CLAUDE.md`, `plugins/list/CLAUDE.md` | document all four |

**`fields/`**

| File | Change |
| --- | --- |
| `enum/plugins/table/web/components/enum-cell.tsx`, `tags/plugins/table/…/tags-cell.tsx` | read `variant`/`hint`; declare `chip: true` |
| `enum/plugins/column-config/web/internal/enum-config.ts` | `EnumOption` gains the two keys |
| `enum/CLAUDE.md` + sub-plugin `CLAUDE.md`s | the option contract is `{value,label,variant?,hint?}` |

**`apps/events/`**

| File | Change |
| --- | --- |
| `events-core/core` | `sourceState()` + `SourceState`, beside `extractionStatus()` |
| `sources/web/internal/format.ts` | variant maps folded into the options arrays; `SOURCE_STATE_OPTIONS` |
| `sources/web/components/sources-list.tsx` | `rowTone`; `visible:false` ×3; `state` field; `type` cell; drop `renderRow` |
| `sources/web/components/source-row.tsx` | **deleted** |

Reused, not rebuilt: `FieldCell`'s existing `field.cell → resolveCell → String(value)`
precedence, `resolveBodyFields`, `useDataViewSections`, `Badge`, `extractionStatus`.

## Verification

1. `./equin build` in the background; confirm
   `~/.singularity/worktrees/<wt>/build-status.json` reads `status: ok`.
2. `./equin check` — `plugin-boundaries` (the new `badge/core` barrel is the
   thing it will judge), `plugins-doc-in-sync`, `type-check`.
3. `./equin test plugins/primitives/plugins/data-view plugins/fields`. New
   suites, following `plugins/list/web/__tests__/row-lines.test.tsx` (hand-built
   `DataViewRenderProps` + `PluginProvider` stub, DOM containment assertions):
   - `list/web/__tests__/row-tone.test.tsx` — a muted row's title carries the muted
     class, a default row does not.
   - `web/internal/resolve-body-fields.test.ts` *(none exists today)* — pure: a
     `visible:false` field is absent under `visibleFields: null`, present under an
     explicit array naming it, and never removed from the sort/filter schema.
   - extend the enum cell test for `variant`/`hint`.
4. In the app at `http://<worktree>.localhost:9000`:
   - **`/events/sources`** — rows are one line, `Failed` is red / `Running` blue /
     `Disabled` grey, no middot glued to a chip, a disabled source's whole line is
     dimmed. Open Properties: `Status`, `Extraction`, `Enabled` are listed and
     unchecked, and checking one adds it to the row.
   - **`Needs attention` tab** — still filters correctly, proving `visible:false`
     did not touch the filter schema. Same for `By type` grouping.
   - **Table view on the same list** — the three hidden fields are absent as
     columns, `state` is present, and rows are *not* toned (the documented no-op).
   - **A list that was already field-driven** — Debug → Reports — picks up tints
     with no edit to it.
   - **A `renderRow` list** — conversations sidebar — is pixel-unchanged.
5. Screenshot before/after:
   ```bash
   bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
     --url http://<worktree>.localhost:9000/events/sources --out /tmp/sources
   ```

## Deliberately out of scope

- **Retiring the other eight `renderRow` sites.** The audit shows each needs
  something outside these three gaps.
- **The deeper patterns the audit surfaced**, should they ever be worth a
  primitive: a bool field rendering as a tooltipped icon rather than text; per-field
  placement/importance instead of primary-plus-joined-rest; tint reaching the
  `leading` slot; a per-field "wrap instead of truncate" escape. Each recurs 2–3
  times across the nine — enough to name, not yet enough to build.
- Table row tone, tinted `ToggleChip`s in editors/filters, and a colour picker for
  user-authored custom enum columns.
