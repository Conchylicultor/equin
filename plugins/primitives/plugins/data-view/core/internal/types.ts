import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { type ComponentType, type ReactNode } from "react";
import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import type {
  Filter,
  FilterDomainId,
} from "@plugins/network/plugins/live/plugins/filter/core";
import type { BadgeVariant } from "@plugins/primitives/plugins/css/plugins/badge/core";
import type {
  LiveColumnRef,
  LiveRowsCollection,
} from "@plugins/network/plugins/live/core";
import type { Rank } from "@plugins/primitives/plugins/rank/core";
import type { ResourceReadiness } from "@plugins/primitives/plugins/live-state/core";
import type {
  ExpandChange,
  LazyChildren,
} from "@plugins/primitives/plugins/tree/core";
import type { DataViewId } from "./define-data-view";
import type { GroupByRule } from "./grouping";
import type { FilterScope } from "./filter-scope";
import type {
  HostedToolbar,
  SectionsToolbar,
  ToolbarArrangement,
} from "./toolbar-arrangement";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import type { LiveDataSource } from "./live-data-source";

export type FieldValue = string | number | boolean | Date | null | undefined;

/**
 * Round-trips a custom column's native cell/editor value ↔ its canonical text
 * storage form. A field type whose value is already a string needs no codec
 * (defaults to `IDENTITY_CODEC`); number/bool/date contribute one so their
 * native values survive the generic `TEXT` storage column. Resolved per field
 * type via `DataViewSlots.ValueCodec` (data-view/web), honoring the `extends`
 * chain — the read twin of the server-side text→typed SQL cast.
 */
export interface ValueCodec {
  decode: (raw: string | undefined) => FieldValue;
  encode: (value: FieldValue) => string;
}

/** Default codec for string-valued types (text/enum): raw text is the value. */
export const IDENTITY_CODEC: ValueCodec = {
  decode: (raw) => raw ?? "",
  encode: (v) => String(v ?? ""),
};

/**
 * Props a per-type add-time column-config editor receives. Rendered in the
 * custom-column Fields settings when the selected field type contributes a
 * `DataViewSlots.ColumnConfig`. `config` is the opaque per-column blob
 * (`FieldDef.config` / `CustomColumnDef.config`); the editor reads/writes it
 * through `onChange` — the host never inspects its shape.
 */
export interface ColumnConfigProps {
  config: unknown;
  onChange: (next: unknown) => void;
}

/**
 * Projects a custom column's opaque per-type `config` blob onto the **generic**
 * `FieldDef` keys it implies — e.g. enum's `config.options` → `FieldDef.options`.
 * Contributed next to the config editor on `DataViewSlots.ColumnConfig`, because
 * the plugin that owns the blob's *shape* is the only one that may read it.
 *
 * This is what keeps `FieldDef.options` the ONE contract every consumer reads.
 * Without it each enum-aware site (cell, inline editor, filter input, group-by
 * section label, …) has to re-derive `field.config.options` itself — and a site
 * that forgets renders the raw stored value (an opaque minted option id) instead
 * of the label, which is exactly how group-by headers came to show internal ids.
 *
 * Pure and called during render: no hooks, no side effects. Only generic keys
 * belong here — `custom-columns` re-applies `id`/`type`/`value`/`onEdit` on top,
 * so a derivation can never redefine a column's identity or storage.
 */
export type ColumnConfigDerive = (
  config: unknown,
) => Partial<FieldDef<unknown>>;

/**
 * A row's projected filter value: a scalar `FieldValue` for normal fields, or a
 * `readonly string[]` for multi-value `tags`-style fields (which project via
 * `FieldDef.values`). The in-memory evaluator coerces it to the operator set's
 * `domain` (one DataView-side adapter) before the filter language — which is
 * strict about its row values — sees it.
 */
export type FilterFieldValue = FieldValue | readonly string[];

/**
 * Describes the data source as a hierarchy. Supplied on `DataViewProps` (not the
 * per-view `options` channel) because it gates which views are available and
 * carries write capabilities. Present → the hierarchical views (tree) become
 * selectable; absent → the host drops them from the switcher.
 */
export interface HierarchyConfig<TRow> {
  getParentId: (row: TRow) => string | null;
  /**
   * Additional (parent → row) reference edges: the row ALSO appears as a
   * read-only leaf ("alias") under each returned parent id — e.g. the pages
   * sidebar rendering the pages a page links to as children of that page. Ids
   * are in the same space as `getParentId` / `rowKey`. Alias rows are pure
   * references: they navigate to the row but expose no rename, no row
   * menu/actions, and no drag; a `child` drop or add-child on an alias resolves
   * to the REAL row it references. A returned parent id that isn't a rendered
   * row, equals the row's own id, or equals the row's real parent (the row is
   * already a child there) is skipped.
   */
  getAliasParents?: (row: TRow) => readonly string[];
  getRank: (row: TRow) => Rank;
  /**
   * DnD reorder/reparent. Omit → read-only nav tree (no drag). The destination
   * is positional INTENT: `dest.parentId` is the destination parent, and
   * `dest.targetId` / `dest.zone` the drop neighbour's row id + side
   * (`"before"`/`"after"`), with `targetId: null` meaning the parent's
   * child-list boundary (`"after"` = append at the end — what a
   * drop-onto-a-row reparent resolves to).
   *
   * There is deliberately **no rank**. A view's rows are always a projection of
   * a shared ordering space (filtered, searched, grouped, or type-scoped), so a
   * rank minted over the rows it can see collides with the siblings it cannot.
   * Every consumer forwards the anchor to its endpoint and lets the server mint
   * against the complete sibling set (`rankAdjacentTo`).
   */
  onMove?: (
    id: string,
    dest: {
      parentId: string | null;
      targetId: string | null;
      zone: "before" | "after";
    },
  ) => void | Promise<void>;
  /**
   * Create child/sibling. Omit → no add buttons. `afterId` is positional intent
   * — place the new row immediately after that existing sibling (absent = the
   * consumer's own default position, normally the end of `parentId`'s children).
   * There is no `rank`: the tree must never mint a key over rows that may be a
   * filtered projection.
   */
  onCreate?: (args: {
    parentId: string | null;
    afterId?: string;
  }) => Promise<string | null | undefined>;
  /**
   * Children listed on demand (a host directory, a remote listing): the rows
   * under a node arrive only after the tree asks for them. `hasChildren` gives a
   * row a chevron before any child is loaded; `state` says where its listing
   * stands (`unloaded` / `loading` / `loaded` / `failed` with a retry), which the
   * tree renders as a placeholder child row; `load` is called by the tree for
   * every OPEN, visible, `unloaded` row — after a chevron click, expand-all,
   * reveal, or an expand map restored on reload alike — so the consumer fetches
   * on first expand without watching the expand map itself. Absent → every
   * row's children are already in `rows`.
   */
  lazyChildren?: LazyChildren<TRow>;
}

/**
 * A typed create affordance — a single "make a new row" action. Non-generic
 * (a creator produces a *new* row, so there is nothing to parametrize on
 * `TRow`), deliberately unlike `HierarchyConfig<TRow>`. The host renders a list
 * of these in the toolbar (1 → `Button`, N → `+` menu) and threads them to
 * views for opt-in surfaces (gallery trailing card + empty-state CTA).
 */
export interface CreateOption {
  /** Stable id (used as the React key in the menu / button list). */
  id: string;
  /** Action label, e.g. "New story", "Import MIDI". */
  label: string;
  /** Already-sized icon element (matches the `CoverContent` icon convention). */
  icon?: ReactNode;
  /** Longer description shown as a muted sub-line in the N-creator menu only. */
  description?: string;
  /**
   * On a `{ kind: "sections" }` surface: the view-instance ids whose section
   * header offers this creator. Absent ⇒ every section. Ignored by every
   * other chrome, which has one create affordance for the whole surface.
   */
  views?: readonly string[];
  /** Run the create action. May be async — the host tracks in-flight busy state. */
  onSelect: () => void | Promise<unknown>;
}

/**
 * Declares a data source as multi-selectable. Presence on `DataViewProps`
 * (mirroring `hierarchy`) enables checkbox multi-select in the views that
 * support it (currently the tree). Gate on `selection != null`, NOT on
 * `bulkActions` truthiness — `selection={{}}` still activates selection.
 */
export interface SelectionConfig {
  /** Bulk-action buttons in the SelectionBar (rendered inside the multi-select
   *  provider, so they may call useMultiSelect()). */
  bulkActions?: ReactNode;
}

export interface ItemActionProps<TRow> {
  row: TRow;
  /** True when this row has at least one child in the data source's hierarchy. */
  hasChildren: boolean;
}

/**
 * Where an action belongs on a view that HAS a permanent per-row slot:
 *
 * - `"persistent"` — important enough to be painted at rest (a Play button).
 * - `"revealed"` — the default: it lives in the hover-revealed cluster.
 *
 * It is a property of the ACTION, declared once at the contribution site, so
 * every view honours the same answer. A view without a permanent slot demotes a
 * persistent action to its revealed cluster — never drops it. The one rule that
 * maps a zone onto a view lives in `useItemActionZones` (web barrel).
 */
export type ItemActionZone = "persistent" | "revealed";

/**
 * Minimal item-actions surface the views consume. `defineItemActions` (web)
 * returns a value satisfying this PLUS the callable contribution-registrar.
 */
export interface ItemActionsDescriptor<TRow> {
  /** Renders ALL contributed actions for one row, each error-boundary-isolated.
   *  `zone` omitted ⇒ every contribution, whatever its zone. */
  Row: ComponentType<ItemActionProps<TRow> & { zone?: ItemActionZone }>;
  /** Which zones actually have a contribution — so a view never paints an empty
   *  cluster for a zone nothing contributed to. */
  useZones: Hook<() => Record<ItemActionZone, boolean>>;
}

/**
 * Props a field-extension contribution receives. A contribution is a **component**
 * (not a plain `FieldDef[]`) so it can gather hook-loaded data (e.g. a live
 * resource keyed by row id) and close its field `value` projections over it,
 * then hand the resulting fields back via `render`. The host folds each
 * contributor's fields into the DataView's schema. The render-callback shape is
 * the generic lift of Sonata's old `Library.Sort` ordering-component slot.
 *
 * Every contributor also receives the surface coordinates — the `storageKey`
 * (which surface) and `rowKey` (how to identify a row) — so a cross-cutting
 * contributor (e.g. custom-columns) can key its per-row data over the surface. A
 * contributor that doesn't need them (e.g. Sonata's play-count, which closes over
 * its own live resource) simply ignores them.
 */
/** Method-position parameter ⇒ checked bivariantly (see `FieldExtensionProps.rowKey`). */
type BivariantRowKey<TRow> = {
  key(row: TRow, index: number): string;
}["key"];

export interface FieldExtensionProps<TRow> {
  /** Which surface this DataView is (the `defineDataView` id). */
  storageKey: DataViewId;
  /** How to identify a row — used to key per-row data. Bivariant on purpose:
   *  with a plain `(row: TRow) => …` this one member made the whole descriptor
   *  invariant, so a surface whose rows EXTEND `R` (the deps tree's
   *  `DepsTreeRow extends TaskListItem`) could not take extensions declared for
   *  `R`. Sound: a contributor only ever keys rows the host handed it, which are
   *  the host's own. `render` stays strict, so the reverse (an extension for a
   *  narrower row on a wider surface) is still a type error. */
  rowKey: BivariantRowKey<TRow>;
  /**
   * The column scope of the live collection this surface reads — its
   * `columnScope`, which the host asserts IS this surface's `storageKey` — or
   * `null` (not a live source, or a collection that takes no scoped columns).
   * A contributor serving scoped columns (custom columns) binds its fields to
   * them (`FieldDef.column`) only under a scope; anywhere else a `column` ref
   * would mean nothing (and is refused).
   */
  liveColumnScope: string | null;
  /** Hand the host this contributor's extra fields (called in render — the
   *  component is mounted, so it may load hook-backed data first). */
  render: (fields: FieldDef<TRow>[]) => ReactNode;
}

/**
 * Minimal field-extensions surface the host consumes. `defineFieldExtensions`
 * (web) returns a value satisfying this (the `RenderSlot`'s own `id` +
 * `useContributions`) PLUS the callable contribution-registrar — mirroring
 * `ItemActionsDescriptor`. The host (`CollectFieldExtensions`) reads
 * `useContributions()` and mounts each contribution isolated under `id`.
 */
export interface FieldExtensionsDescriptor<TRow> extends SlotHandle {
  /** All contributed field-extension components (sealed, like any slot). */
  useContributions: Hook<
    () => readonly SealContributions<{
      id: string;
      /** The heading this contributor's fields are listed under (`null` = they are
       *  ordinary fields of the host's own schema). The host STAMPS it onto every
       *  field the contributor returns — see `FieldDef.section`. */
      section: string | null;
      component: ComponentType<FieldExtensionProps<TRow>>;
      order?: number;
    }>[]
  >;
}

/**
 * One member of a field's closed value set — and how that member PRESENTS.
 *
 * An option describes itself: the chip cell reads `variant`/`hint` straight off
 * the option, so a surface no longer keeps a value→label map and a parallel
 * value→variant map that a render site has to join by hand.
 *
 * Deliberate no-ops: the inline editors and the filter operand input draw
 * `ToggleChip`s, whose vocabulary is not `BadgeVariant`, so they stay untinted;
 * group-by section labels and the control summaries are text-only; server-side
 * filter SQL never reads options at all, so a tint never reaches the server.
 */
export interface FieldOption {
  /**
   * The value's canonical spelling (`fields/core`'s `optionKey`): a string
   * value is itself, a boolean / number its `String` (an enum over a
   * {@link FieldDefBase.valueDomain}), and `"null"` labels the field's
   * no-value — its cell, its group-by "None" section and its filter chip.
   */
  value: string;
  label: string;
  /** Chip tint for the READ cell. Default `"muted"`. */
  variant?: BadgeVariant;
  /** Tooltip on the read chip — why this value means what it means. */
  hint?: string;
  /** Labels filter chips and group sections, but the read cell draws nothing
   *  (`fields/core`'s `FieldOptionMeta.quiet`). */
  quiet?: true;
  /**
   * The `value` of this option's parent option, making the set a forest
   * (e.g. a place category under its group). Absent → a root. Read by
   * {@link optionDescendants} (the "incl. nested" tags operators); a value that
   * names no option, or a cycle, is tolerated there.
   */
  parent?: string;
}

/**
 * Per-row emphasis. `"muted"` dims the row's own text, so a switched-off /
 * archived / finished row reads inactive without spending a chip on saying so.
 *
 * Declared here rather than reusing `css/text`'s `TextTone`: that lives in a
 * plugin with no `core` barrel, and only two of its four tones mean anything
 * for a row.
 */
export type RowTone = "default" | "muted";

/**
 * A field's option set as a READ STATE — for a field whose closed value set is
 * not known up front but read (a live source's facet: the values its column
 * takes, `liveDataSource({ facets })`). Its not-ready arms are a read's own
 * (`ResourceReadiness`: the typed failure and its `refetch`); `loading` and
 * `error` are states the filter input renders as such, never as an empty list
 * — "no options yet" is not "this column has no values".
 */
export type FieldOptionsResult =
  | Exclude<ResourceReadiness, { status: "ready" }>
  | { readonly status: "ready"; readonly options: readonly FieldOption[] };

/**
 * A field's option set is declared (`options`) or read (`optionsResult`) —
 * never both, so no reader has to pick which one wins.
 */
type FieldOptionsSpec =
  | {
      /** type:"enum"/"tags" — the closed value set, and how each value PRESENTS.
       *  Read by the chip cell, the inline editor, the filter input and the
       *  group-by section label. See {@link FieldOption}. */
      options?: FieldOption[];
      optionsResult?: never;
    }
  | {
      options?: never;
      /** The closed value set as a read state (see {@link FieldOptionsResult}).
       *  Read by the filter input, which renders its loading and error arms. */
      optionsResult: FieldOptionsResult;
    };

/** A field of a DataView's schema. `options` xor `optionsResult` (see {@link FieldOptionsSpec}). */
export type FieldDef<TRow> = FieldDefBase<TRow> & FieldOptionsSpec;

/** Every {@link FieldDef} property but its option set. */
interface FieldDefBase<TRow> {
  id: string;
  label: string;
  /**
   * The table column's header text. Default: `label`. `false` ⇒ the column is
   * UNLABELLED — its header cell renders empty (a glyph or position column whose
   * meaning is obvious from its cells) — while the field keeps `label` in every
   * "choose a field" surface (sort, filter, group-by, Properties). A string
   * replaces `label` in the header only. Read by the table view alone.
   */
  header?: string | false;
  /** Field type id (open registry id). Default "text". */
  type?: string;
  /** Comparable projection used for sort/search/filter. */
  value?: (row: TRow) => FieldValue;
  /**
   * The filter domain an `enum` field's VALUES live in when they are not its
   * option strings: an enum over booleans (a probe verdict's `true` /
   * `false`, labelled Online / Offline) or numbers. `value` returns the raw
   * value, `options` are keyed by its canonical spelling (`"true"`), and the
   * enum operators lower a picked option back to the value it spells — so
   * the in-memory evaluator and a server column filter the same values.
   * Absent = the values are the option strings themselves.
   */
  valueDomain?: "boolean" | "number";
  /**
   * Multi-value projection for tags-style fields. Folded into search and read by
   * the filter as a `stringArray` row value. Mutually exclusive with `value`.
   */
  values?: (row: TRow) => string[];
  /**
   * Structured, display-only projection. Read ONLY by the field type's cell
   * (`TableCellProps.data`). Never sorted, filtered, grouped or searched — pair
   * it with `value` if the field must also be comparable.
   */
  data?: (row: TRow) => unknown;
  /** Custom renderer; falls back to String(value ?? ""). */
  cell?: (row: TRow) => ReactNode;
  /**
   * The field's values FAILED to load and no earlier values are held — set by a
   * field whose values come from a read of its own (a field extension). Every
   * cell of the field then renders the failure with its Retry instead of a
   * value, so a failed read never passes for a column of unset cells. Absent
   * while the values are loading or known.
   */
  readError?: { error: Error; refetch?: () => Promise<void> };
  /**
   * The field's values are NOT KNOWN YET — set by a field whose values come
   * from a read of its own (a field extension) while that read is loading
   * with nothing held. Every cell of the field renders the loading block, and
   * a view that groups, sorts or filters by it renders its loading state:
   * whatever `value` returns meanwhile (an enum's `null` is its "None"
   * bucket) would be a claim about every row that then reverses. Absent once
   * the values are known, or failed (`readError`, which a view laid out by
   * the field renders in place of its rows).
   */
  pending?: boolean;
  /**
   * Inline-edit write-back. Present → the table cell for this field becomes
   * editable (click-to-edit); absent → the cell stays read-only (the default for
   * every existing consumer). The host resolves a per-type editor via the
   * `data-view.cell-editor` slot and calls this on commit. Consumer owns
   * persistence — data-view stays presentational.
   */
  onEdit?: (row: TRow, next: FieldValue) => void | Promise<void>;
  /**
   * Multi-value inline-edit write-back. Pairs with `values` exactly as `onEdit`
   * pairs with `value`: present → the table cell becomes editable and the host
   * calls this with the full new array on commit. Mutually exclusive with `onEdit`
   * in practice (a field is scalar or multi). Consumer owns persistence.
   */
  onEditValues?: (row: TRow, next: string[]) => void | Promise<void>;
  /** Default: true when `value` is present. */
  sortable?: boolean;
  /**
   * Whether rows may be partitioned into sections by this field (the group-by
   * picker lists groupable fields only). Default: **true for `enum`/`bool`**,
   * false otherwise — mirroring how `sortable` defaults off `value`. A field
   * with no `value` projection is never groupable regardless of this flag.
   */
  groupable?: boolean;
  /** Include in default search accessor; default true for text/enum. */
  filterable?: boolean;
  /**
   * Under a live `source`: the collection column this field sorts and filters
   * by, when its id is not that column's name (`labels` → `labelIds`) — minted
   * by `collection.column(name)` (or a contributed-column handle), never
   * written. Field ids stay the persisted vocabulary (saved views, presets),
   * so nothing in config moves. A field without one lowers under its own id.
   * On an in-memory DataView it would mean nothing, so it throws
   * at mount.
   *
   * Either way the field's `value` must BE that column's value: the server
   * filters, sorts and — for a one-bucket-per-value grouping — orders and
   * counts sections by the column, so a field showing a derived value (a
   * sender's name over an email column) would be filtered, sorted and grouped
   * by something other than what it shows. A derived field declares none of
   * `sortable` / `filterable` / `groupable` under a live source.
   */
  column?: LiveColumnRef;
  /**
   * CSS grid track size for the table column. Default `"auto"` (content-sized).
   * e.g. `"12rem"` (fixed), `"minmax(0,1fr)"` (absorbs leftover space + truncates).
   */
  width?: string;
  /** Text alignment within the table column (header + cells). Default `"start"`. */
  align?: "start" | "end" | "center";
  /**
   * When a view runs out of room for its columns, the order they give way in:
   * lower drops first.
   *
   * - The **table** (grid presentation) drops numbered fields until its first
   *   column keeps its minimum; a field without one never drops — what still
   *   does not fit scrolls sideways, the first column pinned.
   * - The **tree's aligned columns** drop to keep the row label 160px; there a
   *   field without one drops after every numbered field, rightmost first.
   */
  dropOrder?: number;
  /** Opaque per-type config for custom columns; understood only by the field
   *  type's own code (e.g. enum options). Passed through untouched by the host. */
  config?: unknown;
  /** type:"media" — gallery cover source. */
  cover?: boolean;
  /** The field rendered as the tree row label. Fallback heuristic: first text field, else fields[0]. */
  primary?: boolean;
  /**
   * This field is the row's leading visual (its avatar): list, gallery and tree
   * render its cell in the row's leading slot, ahead of any per-view
   * `leading`/`leadingIcon` content, and leave it out of the body. At most one
   * per schema. The table keeps it as an ordinary column.
   */
  leading?: boolean;
  /**
   * Which titled section of the schema this field belongs to — the heading it
   * is listed under in every "choose a field" surface (filter, sort, group-by,
   * Properties). Absent = the host's own fields, listed first under
   * `SHARED_FIELD_SECTION` ("Common") once anything else IS sectioned.
   *
   * Nothing to do with `groupable`, which is about partitioning ROWS.
   *
   * A field contributed through a field extension never authors this: the host's
   * fold stamps the contribution's own `section` over whatever it returned, so
   * a contributor cannot file its columns under someone else's name. Author it
   * only on a host's base schema, to split a long one into bands of its own.
   */
  section?: string;
  /**
   * Whether the field is in the DEFAULT body set (list subtitle, table column,
   * gallery property row, tree secondary chip). Default `true`. `false` = the
   * field feeds sort / filter / group-by / search only, and the user can still
   * switch it on from the view settings' Properties list.
   *
   * It is a DEFAULT, not an enforcement: a view instance whose config already
   * holds an explicit `visibleFields` array simply does not mention the field,
   * which is indistinguishable from "the user never switched it on". See the
   * plugin CLAUDE.md ("Per-view visible fields").
   */
  visible?: boolean;
}

/**
 * One level of an ordered, multi-level sort. Priority = position in `SortRule[]`.
 * Keyed by `fieldId` (a field is sortable at most once), so no separate uid is
 * needed — `fieldId` is the React key AND the sortable-list drag id.
 */
export interface SortRule {
  fieldId: string;
  direction: "asc" | "desc";
  /** Sorts before every unpinned rule; header cycling, preset apply and
   *  "Clear sort" leave it in place. Pinned rules form a prefix of the list
   *  (`normalizeSortRules` enforces it at the config read/write boundary). */
  pinned?: true;
}

/** A named, reusable multi-level sort. `rules` priority = list order. */
export interface SortPreset {
  /** Stable id (React key + delete/rename target; persisted in the config row). */
  id: string;
  label: string;
  rules: SortRule[];
}

/** A named, reusable filter — the twin of `SortPreset`. `group` is a full
 *  `FilterGroup` tree applied verbatim into the live filter on click. */
export interface FilterPreset {
  /** Stable id (React key + delete/rename target; persisted in the config row). */
  id: string;
  label: string;
  group: FilterGroup;
}

export interface ViewState {
  /** Ordered sort rules (priority = list order). `[]` = unsorted (source order). */
  sort: SortRule[];
  /** Per-view quick search. */
  query: string;
  /** The view's filter tree (root is always a group when present), or null. */
  filter: FilterGroup | null;
  /**
   * Per-view-instance visible-fields policy for BODY rendering (Notion
   * "Properties"). `null`/`undefined` = unconfigured → show ALL fields in schema
   * order (so later-added fields, incl. custom columns, auto-appear). An explicit
   * ordered array = the VISIBLE field ids in body order; any id absent from the
   * array is hidden. Display-only — it never touches sort/filter/search, which
   * always operate on the full field schema.
   */
  visibleFields?: string[] | null;
  /**
   * Which field rows are partitioned by (Notion's "Group by") AND how that
   * field buckets, or absent = ungrouped. Persisted in the per-instance config
   * row exactly like `sort`/`filter` (host-injected, merge-written). Legacy rows
   * without the key are ungrouped; a legacy bare `groupBy: "<fieldId>"` string
   * migrates on read to `{ fieldId, groupingId: "value" }` (see `readGroupBy`).
   */
  groupBy?: GroupByRule;
  /**
   * The view's fold rule, or absent = nothing folds. Persisted in the
   * per-instance config row exactly like `filter`/`groupBy` (host-injected,
   * merge-written). A *softer filter*: rows failing `fold.keep` stay counted and
   * one click away behind a "… N more" fold line at the end of their section.
   * The host suspends it while a search query is typed.
   */
  fold?: FoldRule;
  /**
   * What the filter is evaluated on in a hierarchical view — matching rows plus
   * their ancestors (`rows`, the default) or roots, each keeping its whole
   * subtree (`roots`). See {@link FilterScope}. Persisted in the per-instance
   * config row beside `filter` (host-injected, read-only here — authored, never
   * written by a control). Flat views ignore it.
   */
  filterScope?: FilterScope;
  /** Local expand state for hierarchical views lacking server-persisted expansion. */
  expanded?: Record<string, boolean>;
}

/**
 * A view's fold rule. Rows NOT matching `keep` fold behind a "… N more" fold
 * line at the end of their section — a softer filter: a filter removes rows, a
 * fold keeps them counted (`DataViewSection.count` stays the total) and one click
 * away. `keep` is the ordinary `FilterGroup` language, so every field type's
 * operators, the filter editor, the summary text and the persistence format are
 * shared with `ViewState.filter`.
 */
export interface FoldRule {
  keep: FilterGroup;
}

/**
 * The fold-line key of the implicit ungrouped section (`key === null`) — the key
 * `DataViewFoldLines.open` / `setOpen` use for it. Holds a control char so it can
 * never collide with a real group key.
 */
export const UNGROUPED_FOLD_KEY = "\u0000__dataview_ungrouped__";

/**
 * The fold-line controls the host hands every flat view
 * (`DataViewRenderProps.foldLines`). Present exactly when the view's fold is in
 * effect (a fold rule is set and no search is typed).
 */
export interface DataViewFoldLines {
  /** Section keys whose fold line is open (`UNGROUPED_FOLD_KEY` for the
   *  implicit section). Ephemeral: in-memory, reset on view switch / reload. */
  open: ReadonlySet<string>;
  /** Open or close one section's fold line. */
  setOpen: (sectionKey: string, open: boolean) => void;
  /** The fold rule in words — the fold line's tooltip. */
  summary?: string;
}

/**
 * One partitioned section of a flat view's rows. The unifying envelope every
 * flat view renders against (`useDataViewSections`): when `state.groupBy` is
 * unset the pipeline returns exactly ONE section `{ key: null, … }` mapping rows
 * 1:1, so the un-grouped render is byte-for-byte identical to the old
 * `useFlatRows`-and-map. When grouped, one section per group key in display
 * order, each collapsible with a header label + member count.
 */
export interface DataViewSection<TRow> {
  /** Group key — the `GroupBucket.key` the field type's grouping minted for the
   *  row's value; `null` = the implicit single section rendered headerless when
   *  no group-by is active. */
  key: string | null;
  /** Header label; absent for the implicit (`key === null`) section. */
  label?: ReactNode;
  /** Entry count (post-aggregation, pre-fold) — one per row the user sees, so an
   *  aggregate counts once whatever its `aggregateCount`. The header's number stays
   *  the section's TOTAL while some of its rows are folded. A lower bound when
   *  more rows may still load into the section (see {@link SectionCount}). */
  count: SectionCount;
  entries: DataViewRowEntry<TRow>[];
  /**
   * Present only when the view's fold is in effect AND ≥1 entry of this section
   * fails `FoldRule.keep`. `hidden` counts those entries; `open` says whether the
   * section's fold line is open. While closed, `entries` holds only the kept
   * entries; while open, every entry in sorted order. A renderer draws the
   * section's entries inside a `SectionBody` (web), which ends in the fold line —
   * otherwise its folded rows would vanish.
   */
  fold?: { hidden: number; open: boolean };
  /**
   * Present only on a DECLARED section ({@link DataViewSectioning}): the section
   * pages its own read. A view draws it as the section's footer — `SectionBody`
   * (web) ends in it, so rendering a section body IS rendering its footer. Its
   * first `loadMore()` starts the read: a section reads nothing until it is
   * expanded and its footer has come into view.
   */
  paging?: DataViewSectionPaging;
}

/**
 * How one section pages its own read: a {@link DataViewPaging} with no
 * `isPaged` — every row of the section came from its read.
 */
export type DataViewSectionPaging = Omit<DataViewPaging<unknown>, "isPaged">;

/**
 * A section whose existence and count the SERVER declared (a live source
 * grouped by a groupable column — one `GROUP BY` read), with the rows of its
 * own read. It is listed whether or not any of its rows are loaded: the header
 * and its exact count come from the declaration, the rows from `rows`, the
 * next page from `paging`.
 */
export interface DataViewDeclaredSection<TRow> {
  /** The bucket key (`GroupBucket.key`), or the partition's one "None" key. */
  key: string;
  label: string;
  /** Exact: the server counted it. */
  count: number;
  /** The rows of this section's own read loaded so far, in its order. */
  rows: readonly TRow[];
  paging: DataViewSectionPaging;
}

/**
 * Where a grouped view's sections come from (`DataViewRenderProps.sectioning`):
 *
 * - `bucket` — partitioned from the rows, ordered by each bucket's ordinal (in
 *   memory, and a live grouping the server neither declares nor orders by);
 * - `appearance` — partitioned from the rows, ordered by first appearance,
 *   because the server sorts by the grouped column first (a one-bucket-per-value
 *   grouping over a sortable, non-groupable live column) — which also makes
 *   every section but the last complete;
 * - `declared` — the server listed every section with its exact count, and each
 *   section's rows come from its own read ({@link DataViewDeclaredSection}).
 */
export type DataViewSectioning<TRow> =
  | { kind: "bucket" }
  | { kind: "appearance" }
  | { kind: "declared"; sections: readonly DataViewDeclaredSection<TRow>[] };

/**
 * How many rows a section holds, as far as the loaded rows can say: `exact`
 * when nothing more can arrive in it (every row is loaded, or — sections in
 * row order — a later section has started), else `atLeast` the rows loaded so
 * far. Printed by one formatter (`formatSectionCount`: `n` / `n+`), so a view
 * cannot print a lower bound as a total.
 */
export type SectionCount =
  { kind: "exact"; n: number } | { kind: "atLeast"; n: number };

/**
 * One row entry within a `DataViewSection`. For group-by (Sub-task 1) it is a
 * 1:1 wrapper around a row; the optional `aggregateCount`/`members` fields are
 * the seam for aggregating sections (Sub-task 3), where one entry stands for a
 * collapsed group of rows sharing a key.
 */
export interface DataViewRowEntry<TRow> {
  /** Representative row (== the row when not aggregated). */
  row: TRow;
  /** `rowKey(row)` — the React key + selection/hasChildren identity. */
  key: string;
  /** >1 when this entry stands for a collapsed group (aggregating only). */
  aggregateCount?: number;
  /** Collapsed members (aggregating only). */
  members?: readonly TRow[];
}

/**
 * Aggregating-sections config — the **seam** for Sub-task 3 (collapse rows
 * sharing a key into one representative + count badge). Declared now so
 * `useDataViewSections` can carry it through its `opts` unchanged; the aggregate
 * step itself is NOT implemented in Sub-task 1.
 */
export interface DataViewAggregateConfig<TRow> {
  /** Group rows sharing a non-null key into one representative; `null` =
   *  standalone (never collapsed). */
  getKey: (row: TRow) => string | null;
  /** Pick the representative row for a collapsed group (default: first in
   *  current order). */
  pickRepresentative?: (members: readonly TRow[]) => TRow;
}

/**
 * Flat manual-order config — the flat twin of `HierarchyConfig`. Supplied on
 * `DataViewProps` (not the per-view `options` channel) because it carries write
 * capability and gates the manual-order mode. Present AND the active view opts in
 * (`supportsManualOrder`) → that view orders rows by `getRank` (skipping the
 * field sort, like the tree ignores sort), shows drag affordances, and the host
 * hides the Sort control. Ungrouped → the single implicit `null` section.
 *
 * `onMove` is the **within-a-section** reorder; `onReseat` is the separate,
 * optional cross-section capability. Which drops a view accepts follows from
 * **handler presence** — the same convention `HierarchyConfig` uses for a
 * read-only tree — not from a flag.
 */
export interface ManualOrderConfig<TRow> {
  /**
   * The sort `Rank` of a row — rows render in this order in manual mode.
   * Returning **`null`** marks the row as NOT orderable: it is neither a drag
   * source nor a drop target, and keeps its incoming (source/section) order.
   * A section is homogeneous — either all-ranked or all-null (the consumer
   * guarantees it) — so a null-ranked section simply keeps incoming order.
   */
  getRank: (row: TRow) => Rank | null;
  /**
   * Persist a reorder **within one section**. `id` is `rowKey(row)`;
   * `dest.rank` is the new rank; `dest.targetId` / `dest.zone` are the drop
   * neighbor's row id + side (`"before"`/`"after"`): rank-based consumers ignore
   * them and persist `dest.rank`; endpoint-based (neighbor-based) consumers use
   * them and ignore `dest.rank`.
   *
   * There is deliberately **no destination group**: the drop neighbour is always
   * in the dragged row's own section, so the group is unchanged by construction.
   * A drop into another section goes to `onReseat` instead.
   *
   * Return a promise when the write is in flight and this config's `getRank`
   * only moves once it lands: the host then holds the row at `dest.rank` until
   * `getRank` for it changes (or the promise rejects), so it never snaps back.
   * Return nothing when the new order is already applied (optimistically) or
   * the drop was a no-op.
   */
  onMove: (
    id: string,
    dest: {
      rank: Rank;
      targetId?: string;
      zone?: "before" | "after";
    },
  ) => void | Promise<void>;
  /**
   * Persist a **cross-section** move: a write of the group-by field (moving the
   * row into `dest.groupKey`'s group) **plus** a reorder next to
   * `dest.targetId`/`dest.zone`. Only the consumer can do that — the primitive
   * knows the section key, not which field produced it nor how to write it.
   *
   * Anchor-only on purpose (no `rank`): the destination section's rank space is
   * the consumer's to mint over the complete membership, exactly as
   * `HierarchyConfig.onMove` documents.
   *
   * **Absent ⇒ the view refuses cross-section drops**, and does so *visibly*:
   * while a drag is in flight every row outside the dragged row's section
   * disables its drop zones, so no indicator paints there and the drop cannot be
   * made. (It is not a drop-time no-op — the user sees the refusal mid-gesture.)
   * `groupKey` is `null` for the implicit ungrouped section, which is why the
   * ungrouped surface never reaches this handler.
   */
  onReseat?: (
    id: string,
    dest: {
      groupKey: string | null;
      targetId: string;
      zone: "before" | "after";
    },
  ) => void | Promise<void>;
}

/**
 * How much room the hosting surface gives the view. `"comfortable"` (the
 * default) is the full inline toolbar and the roomier row rhythm; `"compact"`
 * folds every toolbar control behind the one options trigger regardless of
 * measured width, and tightens the rows.
 *
 * It is a per-surface declaration, not a measurement: a narrow surface already
 * folds on its own (the toolbar measures itself), so density only removes the
 * *need for room* — it never claims the surface has any. That is why the two
 * combine with `||` rather than replacing one another: a compact surface that
 * also happens to be narrow is still compact, and a comfortable surface that is
 * genuinely too narrow still folds.
 */
export type DataViewDensity = "comfortable" | "compact";

/**
 * How a grouped view draws its group headers. `"standard"` (the default) is
 * the chevron-led header with the count at the far right; `"quiet"` is one
 * run — label, then its count right beside it — with the fold chevron trailing
 * it and shown only on hover or keyboard focus. A per-surface declaration like
 * {@link DataViewDensity}: a narrow list that wants its headers to read as
 * captions over the rows asks for `"quiet"`.
 *
 * Honoured by every grouped view: the ones that draw their headers through
 * `GroupedSections` (list, gallery, tree, icons), and the table, which composes
 * its own `col-span-full` header rows inside `data-table` but renders the same
 * `DataViewGroupHeader` node in them.
 */
export type DataViewGroupHeaders = "standard" | "quiet";

export interface DataViewRenderProps<TRow> {
  /** RAW rows. Each view applies the processing matching its own semantics
   * (gallery/table call `useFlatRows`; the tree feeds them straight to `TreeList`). */
  rows: readonly TRow[];
  fields: FieldDef<TRow>[];
  rowKey: (row: TRow, index: number) => string;
  /** This view's own state. */
  state: ViewState;
  /**
   * null→asc→desc→null cycle; writes THIS view's sort only. Throws for a field
   * outside `sortHeader.sortable` — a rule this list cannot sort by would
   * replace a live list with its error, persisted in the view's config.
   */
  setSort: (fieldId: string) => void;
  /**
   * What a view's column headers show and offer. `active`: the view's sort
   * rules, for DISPLAY (a header's arrow) — `state.sort` is emptied under a
   * server-ordered source, whose rows arrive sorted. `sortable`: the fields a
   * sort may name (the Sort control's sortable fields — under a live source,
   * the fields bound to a sortable column); a header offers sort on these only.
   */
  sortHeader: { active: readonly SortRule[]; sortable: ReadonlySet<string> };
  /** Writes THIS view's whole filter tree (null clears it). */
  setFilter: (filter: FilterGroup | null) => void;
  /**
   * **Per-row** activation: the handler for THIS row, or `undefined` when this
   * row does not activate. Resolved once by the host from `rowActivation` /
   * `onRowActivate`, so a view never sees the two.
   *
   * The handler is an {@link Activation}: a plain action, or a link
   * (`{ open, href }`) whose ⌘/Ctrl- and middle-click open `href()` in a new
   * browser tab. A view spreads `activationProps(result)` (link-gesture) onto
   * its row element's click props, and runs `runActivation(result)` from any
   * keyboard or programmatic path — never switching on the union itself.
   *
   * A view MUST hand the result straight to those helpers — `undefined` and
   * all — never wrap it in a closure. `Row` infers its element from `onClick`
   * (`row.tsx`), so a closure is never null and every row becomes a `<button>`
   * whose `renderRow` children are then nested inside it. That is invalid DOM
   * for any interactive content a row body holds, and it makes a list where
   * nothing activates announce every row as a button.
   */
  rowActivation?: (row: TRow) => Activation | undefined;
  /**
   * The OPEN gesture — double-click a row, or Enter on a focused row — threaded
   * from `DataViewProps.onRowOpen`. Distinct from `rowActivation` (a single
   * click). Honoured by the tree and the table; absent ⇒ no open gesture.
   */
  onRowOpen?: (row: TRow) => void;
  /** Currently-selected row id (tree highlight + auto-expand-to-selected). */
  selectedRowId?: string;
  /**
   * Whether this view should bring `selectedRowId` into view (expand its
   * ancestors, scroll to it). `false` when the selection was made by clicking
   * the row in ANOTHER section of the same `sections` surface — a starred page
   * clicked in Favorites must not jerk the tree below to its place. The
   * selection still highlights; only the reveal is withheld. Always `true`
   * outside a `sections` surface.
   */
  revealSelection: boolean;
  /** viewOptions[activeViewId] — opaque to the host, typed by each view. */
  options: unknown;
  /** Custom search accessor; each view passes it into its own `useFlatRows`. */
  searchAccessor?: (row: TRow) => string;
  /** Per-row emphasis, threaded from `DataViewProps.rowTone`. Absent ⇒ every
   *  row is `"default"`. list / gallery / tree apply it to the row title; the
   *  table deliberately ignores it (see `DataViewProps.rowTone`). */
  rowTone?: (row: TRow) => RowTone;
  /** Present only when the data source is hierarchical (gates the tree view). */
  hierarchy?: HierarchyConfig<TRow>;
  /**
   * Present → the active view supports manual order AND the consumer supplied a
   * `manualOrder`. The view orders rows by `getRank`, shows drag affordances,
   * and reorders within a section via `rank-reorder`. The host already zeroes
   * this for views that opt out (`supportsManualOrder` falsy), so a view simply
   * checks presence.
   */
  manualOrder?: ManualOrderConfig<TRow>;
  /**
   * Present → rows sharing a non-null `getKey` collapse into one representative
   * entry + count badge (within each section). A pure pipeline transform —
   * orthogonal to the `supports*` flags — so the host threads it to every flat
   * view unconditionally; views read `entry.aggregateCount`/`entry.members` and
   * render the badge in their natural trailing spot.
   */
  aggregate?: DataViewAggregateConfig<TRow>;
  /** Present → the view enables checkbox multi-select (currently the tree). */
  selection?: SelectionConfig;
  /** This view's expand map — the ONE home for tree collapse state. Persisted in
   * ViewState (localStorage), keyed per (surface, view-instance, row). */
  expanded?: Record<string, boolean>;
  /** Write this view's expand map (writes THIS view's ViewState). Always supplied
   *  by the host, so a hierarchical view can rely on it. Batch-shaped: the whole
   *  gesture lands in ONE localStorage write, so expand-all over a large tree
   *  costs one serialization rather than one per row. */
  setExpanded: (changes: readonly ExpandChange[]) => void;
  /**
   * Local midnight of the current day, as epoch ms — the `now` every grouping
   * plans against. Quantized and re-armed at the day boundary by the host
   * (`useGroupingClock`), never read from the clock inside a grouping: an
   * implicit `Date.now()` would change the partition's memo key on every render,
   * and would make the buckets untestable.
   */
  now: number;
  /**
   * Which end of `GroupBucket.order` the sections read from, derived by the host
   * from the view's own sort direction on the grouped field ("asc" when it has
   * none). The host computes it from `activeState.sort` rather than the view's
   * `state.sort`, which a server-ordered source zeroes out — so a
   * server-sorted grouped view still reads the right way round.
   */
  groupOrder: "asc" | "desc";
  /**
   * Whether `rows` is the whole set: always in memory without `paging`; a
   * server-ordered list (live) only once read to its end. Section counts are
   * exact only when it is (or when a later section has started — see
   * `sectioning`; a declared section's count is the server's). `{ growable }`: a list some (or all) of whose rows are a
   * paged read not read to its end ({@link DataViewPaging.isPaged}) — only a
   * section holding a `growable` row can gain rows, so only its count is a
   * lower bound — unless the read's `total` makes it exact
   * ({@link DataViewPagingTotal}).
   */
  rowsComplete: DataViewRowsComplete<TRow>;
  /**
   * Where grouped sections come from — partitioned from `rows` (ordered by
   * bucket, or by appearance), or declared by a live source's server with
   * their own reads. See {@link DataViewSectioning}; a view hands it to
   * `useDataViewSections` untouched.
   */
  sectioning: DataViewSectioning<TRow>;
  /** Device-local set of collapsed group-by section keys (absence = expanded).
   *  Flat views render group headers and hide a section's members when collapsed. */
  collapsedSections?: ReadonlySet<string>;
  /** Toggle a group-by section's device-local collapsed state. */
  setSectionCollapsed?: (key: string, collapsed: boolean) => void;
  /**
   * The fold-line controls, present exactly when `state.fold` is in effect. A
   * flat view passes `foldLines.open` to `useDataViewSections` and renders each
   * section's entries in a `SectionBody` (web), which ends in the fold line for a
   * section carrying `section.fold`. The tree view ignores folding — a
   * deliberate no-op.
   */
  foldLines?: DataViewFoldLines;
  /**
   * The flat paged read's placeholders the body draws around the view — present
   * exactly when it draws them (every row of `rows` is the read's: see
   * {@link DataViewPaging.placeholders}); absent in memory, and under `isPaged`.
   * A declared section's are on its `section.paging`. A grid view reads `before`
   * to keep each card in the column it was drawn in when the pages above it are
   * released or land (the gallery's and icons' phase pad); a stacked view needs
   * nothing from it.
   */
  placeholders?: DataViewPagePlaceholders;
  /** Empty-state node, rendered only on confirmed-empty (`rows.length === 0`).
   *  Views NEVER see a loading state — the host renders the skeleton itself and
   *  skips `renderIsolated` while loading, so empty here always means empty. */
  emptyState?: ReactNode;
  /** Per-item action slot descriptor; views render `<itemActions.Row …/>` in
   *  their own trailing affordance (type-erased; views re-cast at the boundary). */
  itemActions?: ItemActionsDescriptor<TRow>;
  /** True when `rowId` has ≥1 child — derived once by the host from
   *  `hierarchy.getParentId` over `rows`. Flat views (table/gallery) call this
   *  for a correct `hasChildren`; the tree uses its own node count. */
  hasChildren?: (rowId: string) => boolean;
  /**
   * Typed create affordances, threaded from `DataViewProps.creators`. Views may
   * opt into them (the gallery renders a trailing "+" card for a single creator
   * and an empty-state CTA). The host already renders the toolbar affordance —
   * views only render their own surface-specific create UI.
   */
  creators?: CreateOption[];
  /**
   * The surface's declared density, threaded from `DataViewProps.density` so a
   * view child can tighten itself. Absent ⇒ `"comfortable"`. The list child
   * reads it as its default row `size`; the table hands it to `DataTable` as
   * `density`, which pads its rows with the compact row token
   * (`py-row-compact`). The gallery ignores it — a deliberate no-op: its shape
   * is governed by the card grid's cell width, so there is nothing a compact
   * surface would want it to drop.
   */
  density?: DataViewDensity;
  /**
   * The surface's group-header treatment, threaded from
   * `DataViewProps.groupHeaders` exactly like `density`. Absent ⇒
   * `"standard"`. A view hands it to `GroupedSections` as `headerStyle`; the
   * table renders it through `DataViewGroupHeader` (see
   * {@link DataViewGroupHeaders}).
   */
  groupHeaders?: DataViewGroupHeaders;
}

/**
 * Props passed to a `data-view.cell` contribution. `value` is the already-projected
 * `field.value(row)`; `raw` is the row itself (escape hatch only, non-canonical).
 */
export interface TableCellProps {
  value: FieldValue;
  /** Multi-value projection (`field.values(raw)`) for tags-style read cells. */
  values?: readonly string[];
  /** `field.data(raw)` — the structured display projection, `unknown` at this
   *  boundary exactly like `raw` / `FieldDef.config`. */
  data?: unknown;
  field: FieldDef<unknown>;
  raw?: unknown;
}

/**
 * Props passed to a `data-view.cell-editor` contribution — the inline editor for
 * one editable cell. Mirror of `TableCellProps` plus the commit/cancel channel.
 * `value` is the already-projected `field.value(row)`; `raw` is the row (escape
 * hatch). The editor is COMPACT (no label/header), fills the cell, autofocuses on
 * mount, and calls `onCommit(next)` on Enter/blur or `onCancel()` on Esc.
 */
export interface CellEditorProps {
  value: FieldValue;
  /** Current multi-value (`field.values(raw)`) for tags-style editors. */
  values?: readonly string[];
  field: FieldDef<unknown>;
  raw?: unknown;
  /** Commit a new scalar value. The host closes the editor and forwards to FieldDef.onEdit. */
  onCommit: (next: FieldValue) => void;
  /** Commit a new multi-value array. The host closes the editor and forwards to FieldDef.onEditValues. */
  onCommitValues: (next: string[]) => void;
  /** Abandon editing with no change. The host closes the editor. */
  onCancel: () => void;
}

/**
 * Props passed to an operator's `ValueInput` editor — the operand editor for a
 * single filter rule. `value` is the rule's stored operand (JSON-safe); the
 * editor writes new operands through `onChange`.
 */
export interface FilterValueInputProps {
  value: unknown;
  onChange: (value: unknown) => void;
  field: FieldDef<unknown>;
}

/**
 * What `FilterOperator.lower` is handed: the column the clause reads (the
 * field's id) and the clock. `now` is epoch ms; READ IT ONLY WHEN THE OPERAND
 * NEEDS IT (a relative date anchor) — the host records the read and re-renders
 * at the next local midnight only for a filter that made one. Whether `lower`
 * answers `undefined` must never depend on `now`.
 */
export interface FilterLowerContext {
  readonly column: string;
  /** The field the rule is on — an operator reads its `options` (e.g. the
   *  option hierarchy) from it. */
  readonly field: FieldDef<unknown>;
  readonly now: number;
}

/**
 * One operator within a field type's operator set. `lower` translates a rule
 * into the one filter language (`network/live/plugins/filter`) — the in-memory
 * evaluator and a server source run the SAME lowered `Filter`. `ValueInput` is
 * the (optional) operand editor — present iff `hasValue` is true. Living on the
 * operator (not the type) lets `date · is between` (two pickers) and
 * `date · is` (one picker) differ, and value-less operators (`is empty`) render
 * no input.
 */
export interface FilterOperator {
  /** Unique within the set, e.g. "contains", "is-empty". */
  id: string;
  /** Dropdown label, e.g. "Contains", "Is empty". */
  label: string;
  /**
   * Optional section label used to group operators in the picker dropdown.
   * Operators sharing a `group` render under one uppercase-muted header, in
   * first-seen group order; operators with no `group` fall into a single
   * unlabeled default section (the pre-grouping flat-list behavior).
   */
  group?: string;
  /**
   * When true the operator is NOT offered in the picker dropdown, but stays
   * resolvable by id — so an already-saved filter using it still evaluates and
   * still shows its label in the trigger. Deprecation-without-breakage.
   */
  hidden?: boolean;
  /** false → no value editor (is-empty / is-not-empty). */
  hasValue: boolean;
  /** Present iff `hasValue`. The operand editor for a single rule. */
  ValueInput?: ComponentType<FilterValueInputProps>;
  /**
   * The rule as a filter-language `Filter` over `ctx.column` (whose domain is
   * the set's `domain`), or `undefined` when the rule is INCOMPLETE — it
   * constrains nothing (an empty operand, an open range with no bound).
   *
   * One answer serves both the evaluator (an incomplete rule keeps every row)
   * and the chip's rule counter, so the two cannot disagree. `operand` is the
   * rule's stored value (JSON-safe, possibly stale or malformed — read it
   * defensively). A negative operator lowers to a negative op, which is the
   * exact complement of its positive — a row with no value matches it.
   */
  lower: (operand: unknown, ctx: FilterLowerContext) => Filter | undefined;
  /**
   * How this operand reads in the closed Filter control's summary
   * ("Status is none of 2"), or `undefined` to fall back to the generic
   * rendering (string → itself, number/boolean → `String`, a one-element string
   * array → that option's label, a longer one → its count, anything else →
   * omitted).
   *
   * It lives on the OPERATOR beside `lower` for the same reason that one does:
   * the operand's shape is the operator's own. Only `date · is between` knows
   * its operand is a pair of instants; only `bool · is` knows an absent operand
   * means "Unchecked". No operator implements it today — the generic fallback
   * covers every current type — and each one that adopts it improves its own
   * summary with no edit to the summarizer.
   */
  summarize?: (
    operand: unknown,
    field: FieldDef<unknown>,
  ) => string | undefined;
}

/**
 * A `data-view.filter` contribution — one per field type. The host resolves a
 * field's set via the `extends` chain (so inherited types reuse a parent's set).
 */
export interface FilterOperatorSet {
  /** Field type id, e.g. "text". */
  match: string;
  /**
   * The filter-language domain every operator lowers over: the field's column
   * is declared with it, and the in-memory evaluator coerces the row's
   * projected value to it.
   */
  domain: FilterDomainId;
  operators: FilterOperator[];
  /** Op id used when a rule is first created (default: operators[0]). */
  defaultOperator?: string;
}

export type FilterConjunction = "and" | "or";

export interface FilterRule {
  kind: "rule";
  /** Local uid (for React keys / edits). */
  id: string;
  fieldId: string;
  operatorId: string;
  /** Operand, JSON-serializable. */
  value?: unknown;
}

export interface FilterGroup {
  kind: "group";
  id: string;
  conjunction: FilterConjunction;
  children: FilterNode[];
}

export type FilterNode = FilterRule | FilterGroup;

/**
 * The chromes that show ONE active instance: a toolbar band (optionally laid
 * out by an arrangement) with its `title` / `actions`, or a
 * {@link HostedToolbar} whose frame is the surface's own header — which is why
 * `title` / `actions` do not type-check alongside it: the frame renders its
 * own, and a second source would be silently dropped.
 *
 * `MergedDataView` takes only these: it mounts ONE source's data at a time,
 * so it cannot stack every instance as {@link SectionsToolbar} does.
 */
export type DataViewActiveChrome =
  | {
      title?: ReactNode;
      actions?: ReactNode;
      /**
       * How the WIDE toolbar band is laid out — pass an arrangement value (e.g.
       * a plugin's exported arrangement), or a {@link HostedToolbar} for no band
       * at all. Absent → the default bar. The compact fold
       * (`density="compact"` or a narrow toolbar) applies whatever arrangement
       * is passed here.
       */
      toolbar?: ToolbarArrangement;
    }
  | {
      title?: never;
      actions?: never;
      /** No band: the surface's own frame places the options trigger. */
      toolbar: HostedToolbar;
    };

/**
 * The surface's chrome: one of the {@link DataViewActiveChrome}s, or
 * {@link SectionsToolbar} — every instance stacked, each under its own header.
 * A sections surface has no band for `title` / `actions` and no single
 * instance to pin, so all three are type errors beside it.
 */
export type DataViewSurfaceChrome =
  | DataViewActiveChrome
  | {
      title?: never;
      actions?: never;
      pinnedView?: never;
      /** Every view instance, stacked in config order. */
      toolbar: SectionsToolbar;
    };

export type DataViewProps<TRow> = DataViewBaseProps<TRow> &
  DataViewDataOrigin<TRow> &
  DataViewSurfaceChrome;

/**
 * The props a surface's rows are identified and shaped by — for rows the
 * consumer holds in memory. A live `source` refuses these and `hierarchy`:
 * its row key is its collection's `id`, a tree over a partial paged set
 * orphans children, a consumer's rank would reorder server-sorted segments,
 * and its search is the source's `searchable`.
 */
interface DataViewHeldRowProps<TRow> {
  rowKey: (row: TRow, index: number) => string;
  searchAccessor?: (row: TRow) => string;
  /**
   * Flat manual-order accessors + mutation. Present → views that opt in
   * (`supportsManualOrder`: list/table) order by `getRank` and enable rank-based
   * drag reordering; the host hides the Sort control on the active view while
   * manual order is active. Composes with group-by: in-section drags reorder as
   * usual, and cross-section drags are accepted only when the config supplies
   * `onReseat` (otherwise the other sections paint no drop zone).
   */
  manualOrder?: ManualOrderConfig<TRow>;
}

/**
 * Rows the consumer holds — all of them as a tree (`hierarchy`), or a loaded
 * prefix of a paged read (`paging`), never both: a tree over a partial paged
 * set orphans the children whose parents are not loaded yet. Both keys stay
 * optional, so a `HierarchyConfig | undefined` prop still fits its arm.
 * Either way they are rows of a live collection (`collection` — its fields are
 * derived from it, see {@link DataViewBaseProps.fields}), or rows of nothing
 * declared, whose schema is the hand `fields` (required).
 */
export type DataViewInMemoryOrigin<TRow> = DataViewInMemoryRows<TRow> &
  (DataViewHierarchyRows<TRow> | DataViewPagedRows<TRow>) &
  (
    | { collection?: undefined; fields: FieldDef<TRow>[] }
    | {
        /**
         * The live collection the rows come from, when they are one's (the
         * Queue's `conversationsActive`, merged in memory with other reads):
         * its fields — declared by fields, picked and own — and every field
         * an extension exposes for an entity it reaches join the schema,
         * read off the rows (`network/live`, "Fields").
         */
        collection: DataViewRowsCollection;
      }
  );

/** An in-memory origin whose rows form a tree. */
interface DataViewHierarchyRows<TRow> {
  /** Hierarchy accessors + mutations. Present → hierarchical views (tree) appear. */
  hierarchy?: HierarchyConfig<TRow>;
  paging?: never;
}

/** An in-memory origin whose rows are a loaded prefix of a paged read. */
interface DataViewPagedRows<TRow> {
  hierarchy?: never;
  /**
   * `rows` hold a loaded prefix of a longer read that pages as the user
   * scrolls: the body renders the same infinite-scroll footer a live `source`
   * does (loading-more, Retry on a failed page, the line saying it stops),
   * and section counts holding paged rows read as lower bounds until the read
   * is complete. For a consumer that must derive its rows in memory from a
   * paged read (live pages, `pagesPaging`) — a list whose rows ARE one
   * collection's is a live `source` instead.
   */
  paging?: DataViewPaging<TRow>;
}

/** What every in-memory origin holds, tree or paged. */
interface DataViewInMemoryRows<TRow> extends DataViewHeldRowProps<TRow> {
  rows: readonly TRow[];
  /**
   * The state of the read backing `rows` — pass the read itself
   * (`readiness={result}`: any `useLive` / `useResource` / combined result).
   * `loading` renders `loadingState` (default: the view's skeleton), `error`
   * renders `errorState` (default: the failure with Retry), and only `ready`
   * renders the view — so neither a loading nor a failed list can masquerade
   * as a confirmed-empty one (`emptyState` needs `ready` and zero rows).
   */
  readiness?: ResourceReadiness;
  source?: never;
}

/** What a DataView needs of the collection its rows come from: its fields, entity and reach. */
export type DataViewRowsCollection = Pick<
  LiveRowsCollection<unknown>,
  "key" | "exposes" | "fields" | "from"
> & { readonly rowKeys: readonly string[] };

/**
 * What a list may change of one derived field (`DataViewBaseProps.overrides`)
 * — its presentation and which controls offer it, never its value or type.
 * `cell` is a method so an override built against the collection's row type
 * applies to a list whose rows extend it (the Queue's): a cell reads the row
 * the list hands it.
 */
export type FieldOverride<TRow> = Partial<
  Pick<
    FieldDefBase<TRow>,
    | "label"
    | "header"
    | "width"
    | "align"
    | "visible"
    | "groupable"
    | "sortable"
    | "filterable"
    | "primary"
    | "leading"
    | "dropOrder"
    | "section"
  >
> & {
  cell?(row: TRow): ReactNode;
  /**
   * The list's inline-edit write-back (`FieldDefBase.onEdit`): persistence is
   * the list's, never the declaration's — a method for the same reason as
   * `cell`.
   */
  onEdit?(row: TRow, next: FieldValue): void | Promise<void>;
};

/**
 * A list's overrides of its derived fields, by id — built by
 * `fieldOverrides(collection, { … })`, which types the ids against the
 * collection's (an unknown id is a tsc error, and throws at mount).
 */
export interface FieldOverrides<TRow> {
  /** The collection the ids are its fields' (asserted against the DataView's). */
  readonly collection: string;
  readonly byId: Readonly<Record<string, FieldOverride<TRow>>>;
}

/** See {@link DataViewRenderProps.rowsComplete}. */
export type DataViewRowsComplete<TRow> =
  | boolean
  | {
      growable: (row: TRow) => boolean;
      /**
       * The paged read's known total — only while nothing hides rows of it
       * (no search or filter narrows the view); `null` otherwise.
       */
      total: DataViewPagingTotal | null;
    };

/**
 * How many rows a paged read holds in all — loaded or not — when that is known
 * cheaply (a live collection declared `count: true`). A section holding the
 * read's rows then counts exactly: its other rows plus the total — when the
 * read's unloaded rows can only land in it.
 */
export interface DataViewPagingTotal {
  /** Rows in the whole read. */
  count: number;
  /**
   * Field ids every row of the read has ONE value of — so, grouped by one, the
   * unloaded rows land in the section the loaded ones are in (the queue's
   * synthetic `section`: every ended conversation is "done"). Ungrouped, they
   * always do.
   */
  uniform?: readonly string[];
}

/** A read failing under rows that stay on screen — a notice above them, with its own Retry. */
export interface DataViewPageNotice {
  /** Unique among the notices (the failing read's identity). */
  key: string;
  /** The row key of the last row before the failing read; `null` = it is the head. */
  afterRowId: string | null;
  error: Error;
  retry: () => void;
}

/**
 * Which of a paged read's rows a DataView has on screen, by row key, in the
 * read's order: the first and the last drawn and visible, or none of them. A
 * placeholder the read draws ({@link DataViewPagePlaceholder}) is named by
 * its `key`, in its place before or after the rows.
 */
export type DataViewVisibleRows =
  { kind: "none" } | { kind: "rows"; first: string; last: string };

/**
 * A page of a paged read drawn as one placeholder — released past the read's
 * stale budget, its rows dropped — standing in for `rows` rows: the DataView
 * draws it (through `primitives/loading`) at the height those rows had, and
 * reports it on screen by `key`, which subscribes the page again. Never a
 * row: no field of it is ever rendered as a value.
 */
export interface DataViewPagePlaceholder {
  /** Unique among the read's placeholders and row keys. */
  key: string;
  rows: number;
}

/**
 * The placeholders of a paged read: those before its rows and those after
 * them — never between two rows.
 */
export interface DataViewPagePlaceholders {
  before: readonly DataViewPagePlaceholder[];
  after: readonly DataViewPagePlaceholder[];
}

/**
 * Where a DataView reports which of a paged read's rows are on screen — the
 * `sink` of data-view's `usePagesViewport`, whose `viewport` the read pages
 * by. Reported after every settled scroll (and whenever the rows drawn
 * change), never while the DataView is still measuring.
 */
export interface DataViewViewportSink {
  report(rows: DataViewVisibleRows): void;
}

/**
 * The paging state of a read whose loaded rows a DataView shows — see
 * {@link DataViewPagedRows.paging}. A live `source` produces one
 * internally; `pagesPaging` maps a `useLive` read onto it.
 */
export interface DataViewPaging<TRow> {
  /** A next page would add rows. */
  canGrow: boolean;
  /** A next page is loading; the rows shown are the previous ones. */
  growing: boolean;
  loadMore: () => void;
  /** Every row of the read is loaded. */
  complete: boolean;
  /** Paging stopped on a failed read: the footer's Retry re-reads it (never a new page). */
  stalled: { retry: () => void } | null;
  /** Rows exist past the tail that cannot be paged to; `hint` says how to reach them. */
  truncated: false | { hint: string };
  /** Reads failing under rows that stay on screen. */
  notices: readonly DataViewPageNotice[];
  /**
   * Where the DataView reports which of the read's rows it has on screen
   * (`usePagesViewport().sink`) — the read keeps the pages near them live.
   * A read that pages by no viewport (one bounded read, a section not read
   * yet) passes a sink that discards the report.
   */
  viewport: DataViewViewportSink;
  /**
   * The read's pages drawn as placeholders. The DataView draws them before
   * and after the read's rows: a flat read's around the whole view (when
   * every row of the view is the read's — with `isPaged` they are not drawn,
   * since the read's rows sit among others), a declared section's inside its
   * band (`SectionBody`).
   */
  placeholders: DataViewPagePlaceholders;
  /**
   * The read's known total, if any: section counts holding its rows read
   * exact rather than "N+" before every page is loaded (while no search or
   * filter hides rows of it). Absent or `null`: unknown.
   */
  total?: DataViewPagingTotal | null;
  /**
   * Which of `rows` came from the paged read — absent: all of them. They must
   * appear in `rows` in the read's order, so the LAST one is the read's tail:
   * the page after it loads only while that tail is on screen (not folded,
   * not in a collapsed section, not hidden by the view's search or filter).
   */
  isPaged?: (row: TRow) => boolean;
}

/**
 * A live `network/live` collection read as key-range pages
 * (`liveDataSource`): the view's sort, filter, search and group-by lower onto
 * its window params, and the rows stay live through the routed runtime.
 */
export interface DataViewLiveOrigin<TRow> {
  source: LiveDataSource<TRow>;
  rows?: never;
  collection?: never;
  readiness?: never;
  paging?: never;
  rowKey?: never;
  searchAccessor?: never;
  hierarchy?: never;
  manualOrder?: never;
}

/** Where a DataView's rows come from — exactly one, so a stand-in (`rows={[]}` beside a server source) cannot be spelled. */
export type DataViewDataOrigin<TRow> =
  DataViewInMemoryOrigin<TRow> | DataViewLiveOrigin<TRow>;

/**
 * Every `DataViewProps` key except the data origin ({@link DataViewDataOrigin})
 * and the surface chrome ({@link DataViewSurfaceChrome}).
 */
/** A controlled search query — see {@link DataViewBaseProps.search}. */
export interface DataViewSearch {
  query: string;
  onQueryChange: (query: string) => void;
}

export interface DataViewBaseProps<TRow> {
  /**
   * The schema BY HAND — for rows of no collection declared by fields (an
   * in-memory list of rows from nothing declared: required there). A list
   * whose collection is declared by fields (`liveCollection({ from, pick,
   * fields })`) DERIVES its schema — the collection's fields, the exposed
   * fields of every entity it reaches, its arms' fields, each presented by
   * its registration (`FieldPresentation`) — and passing `fields` beside one
   * throws: it says what to change with `overrides` and adds with
   * `extraFields`. (Beside a collection in the old `row` spelling, `fields`
   * is still its base schema, until phase 2b deletes that spelling.)
   */
  fields?: FieldDef<TRow>[];
  /** Changes to derived fields, by id (`fieldOverrides(collection, { … })`). */
  overrides?: FieldOverrides<TRow>;
  /**
   * Fields the list computes itself (the Queue's `section`), after the
   * derived ones — an id a derived field already uses throws.
   */
  extraFields?: FieldDef<TRow>[];
  /** Restrict + order by view id; omitted → all contributions by order/title. */
  views?: string[];
  defaultView?: string;
  /**
   * Show exactly this view instance, and hide the switcher.
   *
   * The active instance is otherwise device-local **per `storageKey`**, so every
   * host of one surface shares a selection — which is right for hosts that are
   * tab strips over the same thing, and wrong for a host that is one scoped list
   * ("the backups", inside the backup app). A pinned host reads the named
   * instance and never writes the shared selection, so it cannot drag the other
   * hosts onto its own tab.
   *
   * Hiding the switcher is part of the same decision rather than a second prop:
   * a visible switcher whose selection does not persist is worse than none.
   *
   * Names an instance that the surface's config does not author → the surface
   * says so instead of quietly falling back to whatever tab was last used.
   */
  pinnedView?: string;
  storageKey: DataViewId;
  /**
   * Per-row emphasis — see {@link RowTone}. A data accessor closed over row
   * identity (the `searchAccessor` shape), NOT a declaration about the surface
   * like `density`, so it flows straight through to the view children.
   *
   * Honoured by list / gallery / tree on the row's own title. The TABLE is a
   * deliberate no-op: its only per-row seam (`DataTableProps.useRowDecoration`)
   * is already held by manual-order drag decoration, and merging two
   * decorations is its own change.
   */
  rowTone?: (row: TRow) => RowTone;
  /**
   * Every row activates, this way. The simple case, and what most surfaces want.
   *
   * Mutually exclusive with {@link DataViewProps.rowActivation} — passing both
   * throws, because two props asserting whether a row activates can disagree.
   */
  onRowActivate?: (row: TRow) => void;
  /**
   * **Per-row** activation: the handler for this row, or `undefined` when this
   * row does not activate.
   *
   * A resolver rather than a predicate beside `onRowActivate`, so there is no
   * second fact to keep in step: the handler's PRESENCE is what says the row
   * activates. A row that resolves to nothing renders as a plain container
   * rather than a button, which is what lets its body hold an interactive
   * control — a `<button>` inside a `<button>` is invalid DOM, and the outer row
   * swallows the click.
   *
   * `undefined` and not `null`, matching the render-props shape it is folded
   * into: the value's destination is an `onClick`, and a second spelling of
   * "no handler" bought only an impedance mismatch at that boundary. (`null`
   * would additionally reject an implicit return — but a resolver that falls off
   * the end means precisely "this row does not activate", so that is a spelling
   * difference, not a mistake worth a type error.)
   *
   * Reach for it when one list holds rows of different kinds: a merged run list
   * where builds open a detail pane and backups offer a Grant-access button.
   *
   * **A row that opens a pane returns a link**, so middle- and ⌘-click open it
   * in a new browser tab as on any link:
   * `rowActivation={(r) => openPane.to(detailPane, { id: r.id }, { mode: "push" })}`.
   * A plain `() => void` is for activation that is not navigation.
   */
  rowActivation?: (row: TRow) => Activation | undefined;
  /**
   * The OPEN gesture: double-click a row, or press Enter on a focused one —
   * distinct from activation (a single click). A file browser's "click selects,
   * double-click descends / opens". Honoured by the tree and the table (where a
   * focused row's Enter then opens, and Space still activates); the list,
   * gallery and icons views ignore it.
   */
  onRowOpen?: (row: TRow) => void;
  /**
   * A CONTROLLED search query, for a surface whose search field lives in its
   * own chrome (a file browser's toolbar filter). Present → this query is the
   * one every view applies and every built-in search field shows, and edits go
   * to `onQueryChange`; the per-tab stored query is neither read nor written.
   * Absent → the host owns the query (per browser tab), the default.
   */
  search?: DataViewSearch;
  /** Currently-selected row id (tree highlight + auto-expand-to-selected). */
  selectedRowId?: string;
  emptyState?: ReactNode;
  /** Override the loading render; default is each view's own skeleton shape. */
  loadingState?: ReactNode;
  /**
   * Override the render of a failed read (`readiness.status === "error"`);
   * default `<ResourceErrorInline variant="block"/>` — the failure's message
   * with Retry, or Reload when the tab is out of date. Never `emptyState`.
   */
  errorState?: ReactNode;
  /** Opaque per-view options channel, keyed by view id. */
  viewOptions?: Record<string, unknown>;
  /**
   * Aggregating sections — collapse rows sharing a non-null `getKey` into one
   * representative row + count badge (within each group-by section). Present →
   * flat views (list/table/gallery) render the representative with a `×N` badge;
   * absent → every row renders 1:1 (the default). "Acting on the representative
   * acts on the group" is the consumer's mutation concern — the primitive only
   * owns the visual collapse + representative selection + count badge. Composes
   * with `manualOrder` (collapse the rank-ordered entries) and group-by.
   */
  aggregate?: DataViewAggregateConfig<TRow>;
  /** Present → selectable views (tree) enable checkbox multi-select. */
  selection?: SelectionConfig;
  /** Per-item action slot descriptor minted by `defineItemActions`; views render
   *  each contributed action in their natural trailing affordance. */
  itemActions?: ItemActionsDescriptor<TRow>;
  /**
   * Optional cross-plugin field contribution surface minted by
   * `defineFieldExtensions`. Present → the host folds every contributor's extra
   * `FieldDef[]` into `fields` BEFORE the sort/filter controllers and the view
   * render-props, so contributed fields appear in the Sort pill, Filter pill, and
   * table columns for free. Each contributor is a component (it may load
   * hook-backed data), so the merge happens through a render-callback fold.
   */
  fieldExtensions?: FieldExtensionsDescriptor<TRow>;
  /**
   * Typed create affordances. The host renders them in the toolbar (1 → a
   * `Button`, N → a "+" dropdown menu, with host-owned in-flight busy state) and
   * threads them to views (gallery trailing card + empty-state CTA). Domain-pure
   * — a `CreateOption` carries only `id`/`label`/`icon`/`description`/`onSelect`.
   */
  creators?: CreateOption[];
  /**
   * How much room this surface gives the view — see {@link DataViewDensity}.
   * A small popover or a dense side panel declares `"compact"` and gets the
   * folded chrome (one options trigger) plus tighter rows without having to be
   * narrow enough for the toolbar's own measurement to catch it. Default
   * `"comfortable"`.
   */
  density?: DataViewDensity;
  /**
   * How grouped views draw their group headers — see
   * {@link DataViewGroupHeaders}. Default `"standard"`.
   */
  groupHeaders?: DataViewGroupHeaders;
  /**
   * The search field's placeholder, naming what this surface searches
   * ("Search apps"). Default `"Search…"`.
   */
  searchPlaceholder?: string;
  /**
   * A panel the surface places beside its view — a facet sidebar, a tag
   * tree. It renders INSIDE the DataView's controls context, so code in it
   * reads and edits the active view's state through `useDataViewControls()`
   * (`filter.setFilter(…)`, `sort`, the query) exactly as a toolbar control
   * does; the view body stays outside that context.
   *
   * Placement is the toolbar's: beside an {@link ToolbarArrangement.overlay}
   * arrangement it is a floating card on the left (the surface's height minus
   * gutters, its own scroll), and the arrangement's cards start past it
   * (`ToolbarParts.asideInset`); otherwise it is a left column beside the band
   * and the view. The panel sizes its own width. Shown once the surface has an
   * active view (there is no view state to edit before). Only a band chrome
   * takes it: a hosted or sections toolbar throws.
   */
  aside?: ReactNode;
}
