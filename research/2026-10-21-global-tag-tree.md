# Tag trees — one nested-tag system for Prototypes and Places

Status: design, approved scope. Implementation agents: read §0–§3 fully, then
your phase in §7. Approved mockup (the UI must match it):
`~/.singularity/apps/prototypes/proto-1792526257-f0gpsa/index.html`.

## 0. What the user gets

```ts
// core/ — a plugin declares one tree in three literal declarations
export const prototypeTagsEntityRef = tagTreeEntityRef("prototype_tags", { idKind: prototypeTagIdKind });
export const prototypeTags = liveCollection("prototypes.tags.all", tagTreeCollectionSpec(prototypeTagsEntityRef));
export const prototypeTagTree = defineTagTree({ id: "prototypes", entity: prototypeTagsEntityRef, collection: prototypeTags });

// server/internal/tables.ts
const prototypeTagsTable = defineTagTreeTable(prototypeTagsEntityRef);
export const _prototypeTags = prototypeTagsTable.table;

// server/ — serve it, say who carries tags
contributions: [
  ...serveCollection(prototypeTags, { from: _prototypeTags }).declare,
  TagTrees.Tree(serveTagTree(prototypeTagTree, { table: _prototypeTags,
    carriers: [singleTagCarrier(_prototypeState, _prototypeState.tagId)] })),
]

// web/ — pick a tag
<TagPickerPopover tree={prototypeTagTree} selected={tagId} offerNone
  counts={counts} onPick={(id) => setState(name, { tagId: id })}
  trigger={<TagPathChip tree={prototypeTagTree} tagId={tagId} />} />

// a DataView field whose options form a forest groups as NESTED sections
{ id: "tag", label: "Tag", type: "tag", options: tagFieldOptions(tags), value: (p) => p.tagId }
```

- Prototype detail header: a chip right after the title (`app / … / homepage`
  + colour dot, or dashed `＋ Tag`) opening the picker. Pin / Done unchanged.
- Gallery: group by **Tag** → nested sections (app ▸ website ▸ homepage),
  rolled-up counts, a parent's own rows above its child sections, each level
  folds independently, untagged in the usual **None** section last.
- Places keeps its data (`place_tags` table, `ptag-…` ids) and gains the same
  picker (create / rename / recolour / nest / reorder) on its `＋ Tag` button.

## 1. Mental model (state it in the docs)

- A **tag tree** is a per-plugin DB table of tags (name, parent, colour, icon,
  fractional rank). Each tree is its own table; trees never share rows. The
  generator, the endpoints, the helpers and the UI are shared.
- A **carrier** is a row that references tags of a tree (a prototype's one
  `tagId`; a place's `tags` list). Carriers live in the owning plugin; the tree
  only knows how to rewrite them when a tag is deleted.
- **Prototype files are host-global; prototype state is per-instance.** The
  folders under `~/.singularity/apps/prototypes/` stay shared by every
  worktree and main. Pinned / Done / tag are rows in the instance's DB: a
  worktree changes them in its own DB fork without touching main. Intended.

## 2. Plugin layout and runtime split

New top-level umbrella `plugins/tag-tree/` (precedent: `history/`, `search/`
— a reusable primitive with an engine + UI split; not under `infra/` or
`primitives/`). Plus one field type under `fields/`.

| Plugin | Runtimes | Owns |
|---|---|---|
| `tag-tree` (umbrella) | — | `CLAUDE.md`, `package.json` only |
| `tag-tree/plugins/engine` | core, server, web | declaration helpers, tag field record, pure tree helpers, palette, the ONE endpoint set, server generator + registry + handlers, web hooks |
| `tag-tree/plugins/picker` | web, exhibits | `TagPickerPanel` (pure), `TagPickerPopover` (wired), `TagPathChip`, `TagMark` |
| `fields/plugins/tag` | core, web | the `tag` field type (one value from an option forest; identity `extends` enum) |
| `fields/plugins/tag/plugins/data-view-group` | core, web | the `tag` type's nested grouping (`DataViewSlots.Grouping`) |
| `primitives/data-view` (existing) | core, web | nested sections (generic: a grouping whose buckets carry ancestors) |
| `apps/prototypes/plugins/state` (new) | core, server, web | `prototype_state` + `prototype_tags` tables, the tree, the state endpoint, the one-time `_status` import |

`fields/plugins/tag` knows nothing about tag trees: its grouping reads
`FieldOption.parent`, which any forest-shaped option set already has (the
Places tags filter uses it). Collection-consumer separation holds: the
`tag-tree` server owns the tree registry, contributors register, the generic
handlers never name a tree.

## 3. tag-tree/engine — exact API

### 3.1 core (`@plugins/tag-tree/plugins/engine/core`)

Files: `core/internal/{fields,declare,schema,endpoints,tree,palette,path}.ts`.

```ts
// fields.ts — the base field record, in column order
export const CHILD_COLOR_MODES = ["ramp"] as const;           // moved from places-core
export type ChildColorMode = (typeof CHILD_COLOR_MODES)[number];
export function tagTreeFields<P extends string, X extends FieldsRecord = {}>(
  idKind: IdKind<P>, extraFields?: X,
): {
  id: idKindField(idKind);
  name: textField({ label: "Name", primary: true });
  parentId: nullable(textField());          // null = root; never a cycle (server-enforced)
  color: nullable(textField());             // #rrggbb; null inherits (tagColor)
  childColors: nullable(enumTextField(CHILD_COLOR_MODES));
  icon: nullable(parsedTextField(SavedSymbolNameSchema, …));  // the places `savedIcon()` helper, moved here
  rank: rankField();                        // fractional Rank, rank_text domain
} & X & { createdAt: dateField(); updatedAt: dateField() };

// declare.ts
export function tagTreeEntityRef<N extends string, P extends string, X extends FieldsRecord = {}>(
  table: N, spec: { idKind: IdKind<P>; extraFields?: X },
): EntityRef<N, TagTreeFields<P, X>>;      // = entityRef(table, tagTreeFields(idKind, extraFields))

/** The `liveCollection` spec of a tree: the WHOLE set in rank order. Pass to
 *  `liveCollection("<literal key>", …)` — the key must stay a literal (resource
 *  scanners, plugins/framework/plugins/tooling/plugins/resource-vocabulary). */
export function tagTreeCollectionSpec<R extends AnyTagTreeEntityRef>(
  entity: R, opts?: { listFields?: readonly ExtraKeyOf<R>[] },
): /* { from: entity, pick: ["name", ...listFields], carry: { pick: <every other field> },
       id: "id", all: { orderBy: [["rank","asc"]],
       unbounded: { reason: "a person adds every tag by hand, and the tag tree is read whole" } } } */;

export interface TagTree<Row extends TagRow = TagRow> {
  readonly id: string;                       // the `:tree` route param, [a-z][a-z0-9-]*, unique (boot throws on a duplicate)
  readonly entity: AnyTagTreeEntityRef;
  readonly collection: LiveAllCollection<Row>;
}
export function defineTagTree<Row extends TagRow>(spec: {
  id: string; entity: AnyTagTreeEntityRef; collection: LiveAllCollection<Row>;
}): TagTree<Row>;

// schema.ts
export const TagRowSchema;  // fieldsToZodObject of the base record (extras stripped)
export type TagRow = { id; name; parentId: string|null; color: string|null;
  childColors: ChildColorMode|null; icon: SavedSymbolName|null; rank: string; createdAt; updatedAt };
export const HexColorSchema;          // moved from places endpoints: /^#[0-9a-fA-F]{6}$/

// palette.ts
export const TAG_PALETTE;             // moved verbatim from places tag-manager/web/internal/palette.ts (18 hex)
```

If `tagTreeCollectionSpec`'s generic typing fights `liveCollection`'s
inference, consumers may inline the object literal (same contents) — do not
weaken `liveCollection`'s types for it.

**Pure helpers** (`tree.ts`, generalized from
`apps/places/plugins/places-core/core/internal/tag-tree.ts`, keeping its
WeakMap index and orphan-as-root behaviour; siblings sort by `rank` string
compare `a < b`, which equals `Rank.compare` and the DB's C collation):

```ts
export interface TagNode { readonly id: string; readonly parentId: string | null;
  readonly color: string | null; readonly childColors: ChildColorMode | null; readonly rank: string }
export function flattenTagTree<T extends TagNode>(tags: readonly T[]): { tag: T; depth: number }[];
export function tagPath<T extends TagNode>(tagId: string, tags: readonly T[]): T[];          // root first
export function tagPathLabel(tagId: string, tags: readonly (TagNode & { name: string })[], sep?: string): string; // default " / "
export function tagDescendants<T extends TagNode>(tagId: string, tags: readonly T[]): T[];
export function isTagUnder(tagId: string, ancestorId: string, tags: readonly TagNode[]): boolean;
export function wouldCycle(tagId: string, parentId: string | null, tags: readonly TagNode[]): boolean;
export function tagColor(tagId: string, tags: readonly TagNode[]): string | null;          // own → ramp shade → ancestor
export function rampShade(hex: string, i: number, n: number): string;
/** How many items carry each tag or anything under it; an item counts once per tag. Absent = 0. */
export function rolledUpTagCounts(items: Iterable<readonly string[]>, tags: readonly TagNode[]): Map<string, number>;
/** A tree as `FieldOption`s: flatten order, `parent` set, `swatch` = tagColor. */
export function tagFieldOptions(tags: readonly (TagNode & { name: string })[]): FieldOption[];

// path.ts — shared by the picker's "Create a / b / c" preview and the server's createPath
export function parseTagPath(input: string): string[];          // split on "/", trim, drop empties
export function resolveTagPath(segments: readonly string[], tags: readonly (TagNode & { name: string })[]):
  { name: string; tagId: string | null }[];   // walks from the root, case-insensitive sibling match; null = to create (and every later one)
```

**Endpoints** (`endpoints.ts`) — one set for every tree, literal routes:

| Endpoint | Route | Body | Response |
|---|---|---|---|
| `createTag` | `POST /api/tag-trees/:tree/tags` | `{ name: string(trim,min1), parentId?: string\|null, color?: hex\|null, icon?: SavedSymbolName\|null, extra?: Record<string,unknown> }` | `{ id: string }` |
| `createTagPath` | `POST /api/tag-trees/:tree/paths` | `{ segments: string[] (each trim,min1; min 1) }` | `{ id: string, created: string[] }` |
| `updateTag` | `PATCH /api/tag-trees/:tree/tags/:id` | `{ name?, color?: hex\|null, childColors?: "ramp"\|null, icon?: …\|null, extra? }` | 204 |
| `moveTag` | `POST /api/tag-trees/:tree/tags/:id/move` | `{ parentId: string\|null, targetId: string\|null, zone: "before"\|"after" }` | 204 |
| `deleteTag` | `DELETE /api/tag-trees/:tree/tags/:id` | — | 204 |

`moveTag`'s body is exactly `useTreeModel`'s `onMove` dest
(`primitives/tree`), so the picker passes it through. "Nest inside X" =
`{ parentId: X, targetId: null, zone: "after" }`; "Move out of P" =
`{ parentId: P.parentId, targetId: P.id, zone: "after" }`. There is no
parentId/rank in `updateTag` — position changes only through `moveTag`.
Rows reach clients only through the live collection.

### 3.2 server (`@plugins/tag-tree/plugins/engine/server`)

```ts
/** The table — a load-order leaf, call it from the plugin's tables.ts. Wraps defineEntity:
 *  primaryKey id; defaults createdAt/updatedAt now; derived updatedAt (every base column
 *  touches it except id/createdAt; `touchedBy` REQUIRED for each extra key — tsc);
 *  index `<table>_parent_rank_idx` on (parent_id, rank). `columns`/`indexes` pass through
 *  to defineEntity meta (so `columns.rank.name` can rename the DB column — Places uses it). */
export function defineTagTreeTable<R extends AnyTagTreeEntityRef>(entity: R, meta?: {
  columns?: EntityColumnsMeta<R>; indexes?: (t) => IndexBuilder[]; touchedBy?: Record<ExtraKeyOf<R>, boolean>;
}): { table: PgTableOf<R> };

export interface TagCarrier {
  /** Inside the delete's transaction: every carrier of `deletedId` gets `parentId` instead (nothing at the root). */
  replaceDeleted(tx: DbTx, deletedId: string, parentId: string | null): Promise<void>;
}
/** A nullable single-tag column: UPDATE t SET col = parentId WHERE col = deletedId. */
export function singleTagCarrier(table: PgTable, column: AnyPgColumn): TagCarrier;

export interface ServedTagTree { readonly tree: TagTree; /* + internal repo handle */ }
export function serveTagTree(tree: TagTree, opts: {
  table: PgTableOf<…>;
  carriers: readonly TagCarrier[];
  /** Extra fields a client may set through create/update `extra`; others → 400. Default none. */
  editableExtras?: readonly ExtraKeyOf<…>[];
  /** A reason to refuse deleting this tag (→ 400), or null. */
  refuseDelete?: (tag: Row) => string | null;
}): ServedTagTree;

export const TagTrees = {
  Tree: defineServerContribution<ServedTagTree>("tag-tree.tree", { docLabel: (s) => s.tree.id }),
};
```

The engine's own `server/index.ts` registers `httpRoutes` for the five
endpoints; each handler resolves `:tree` from `TagTrees.Tree.getContributions()`
at call time (unknown tree → 404; two contributions with one id → throw at
first resolution, loud). Every write runs in `db.transaction` after
`LOCK TABLE <tree table> IN SHARE ROW EXCLUSIVE MODE` (rank minting and path
creation must see the complete sibling set; precedent: places
`seedPlaceTagsWarmup`). Semantics:

- **create**: parent must exist (404); a sibling with the same name
  (case-insensitive) → 400; rank = `nextRankUnder(table, parentId)`;
  `extra` parsed with `pick(editableExtras).partial().strict()`.
- **createPath**: `resolveTagPath` on the locked rows; insert each missing
  segment under the previous (appended); returns the leaf id and the created ids.
  All segments existing → returns the leaf, `created: []`.
- **update**: rename to a sibling's name → 400; blank name → 400 (schema).
- **move**: target parent must exist; `wouldCycle` → 400 "A tag cannot move
  under itself"; rank = `rankAdjacentTo(siblingsOfDestParent, parentId,
  targetId, zone, new Set([id]))` (`primitives/rank/server`).
- **delete**: `refuseDelete` → 400; then in the transaction: children
  re-parented to the tag's parent **at the tag's position** (ranks =
  `Rank.nBetween(prevSiblingRank, nextSiblingRank, children.length)`, in their
  order); every carrier's `replaceDeleted`; delete the row.

### 3.3 web (`@plugins/tag-tree/plugins/engine/web`)

```ts
export function useTagTree<Row extends TagRow>(tree: TagTree<Row>): ResourceResult<Row[]>;   // useLive(tree.collection)
export function useTagTreeActions(tree: TagTree): {
  create(body): Promise<{ id: string }>; createPath(segments): Promise<{ id: string; created: string[] }>;
  update(id, body): Promise<void>; move(id, dest): Promise<void>; remove(id): Promise<void>;
  pending: boolean;
};   // useEndpointMutation over the five endpoints with params.tree = tree.id
```

## 4. tag-tree/picker — the mockup

`TagPickerPanel` is pure (props in, callbacks out — exhibit + jsdom testable);
`TagPickerPopover` wires it to `useTagTree` / `useTagTreeActions` inside an
`InlinePopover` (`primitives/overlay/plugins/popover`) anchored on `trigger`.

```ts
interface TagPickerProps {
  tree: TagTree;
  /** Ids currently chosen; the ✓ marks them. Single-tag carriers pass [id] or []. */
  selected: readonly string[];
  /** Tags that cannot be picked (Places: role tags + tags already on the place).
   *  An excluded tag with a pickable descendant stays as a dimmed, unpickable row; otherwise hidden. */
  exclude?: (tag: TagRow) => boolean;
  /** Rolled-up carrier counts (rolledUpTagCounts); absent → no count column. */
  counts?: ReadonlyMap<string, number>;
  /** Show "No tag" at the top while `selected` is non-empty (single-tag carriers). */
  offerNone?: boolean;
  /** A row was picked (or "No tag" → null); the popover closes. A created path picks its leaf. */
  onPick(tagId: string | null): void;
}
export function TagPickerPopover(props: TagPickerProps & { trigger: ReactElement }): ReactNode;
export function TagPathChip(props: { tree: TagTree; tagId: string | null }): ReactNode;  // header chip
export function TagMark(props: { tag: TagRow; tags: readonly TagRow[]; className?: string }): ReactNode;  // moved from places tag-manager
```

Behaviour (match the mockup exactly; **no instructional text, no kbd hints**):

- Search input, placeholder `Search or create…`, autofocus. Empty query:
  foldable tree (disclosure ▶/▼ only on rows with children; colour dot via
  `TagMark`; name; rolled-up count; ✓ on selected), initially expanded along
  the selected tag's path. `No tag` row first when `offerNone && selected.length`.
  Footer divider + `＋ New tag` (root draft row).
- Query: flat rows of every tag whose full path contains it, sorted by path,
  shown as `anc / anc / leaf` with the match highlighted; no disclosure, not
  draggable. When no tag's full path equals the query (case-insensitive), a
  `Create a / b / **c**` row (existing segments muted, new ones bold, from
  `resolveTagPath`); Enter or click → `createPath` → `onPick(leaf)`.
- Row hover reveals `＋` (add sub-tag: an inline draft row under it, parent
  auto-expanded) and `⋯` (menu); the count hides while they show. Click row =
  pick + close. Double-click = rename inline (Enter/blur commits, Escape
  reverts, blank reverts). A draft row commits via `create` on Enter/blur,
  discarded if blank.
- `⋯` menu: Rename · Add sub-tag · `Move out of "<parent>"` (only with a
  parent) · divider · swatches (`same as parent` dashed swatch only with a
  parent → `color: null`; then `TAG_PALETTE`, 6 per row, current ringed) ·
  divider · Delete (danger, immediate — children and carriers move to the parent).
- Drag a row directly (no handle). Drop zone by pointer Y in the target row:
  top 28% = before, bottom 28% = after, middle = nest inside (end of children,
  target auto-expands). Dropping on itself/its descendants is not offered.
  Build on `primitives/tree` web (`useTreeModel` with `onMove`/`onCreate`,
  `TreeRowChrome`, `TreeDropZones`, `TreeDisclosureToggle`, `TreeRowActions` +
  `RowMenu`); rows adapt `{ ...tag, rank: Rank.from(tag.rank), expanded }`.
  If the primitive only drags by a handle, add a whole-row drag option to
  `primitives/tree` (generic) rather than hand-rolling DnD in the picker.
- `TagPathChip`: pill; tagged → dot + path, collapsed to
  `first / … / leaf` past two levels (ancestors muted), caret; untagged →
  dashed `＋ Tag`. Open state ringed in accent.

Exhibits (`tag-tree/plugins/picker/exhibits/`): `tag-tree/picker` —
`TagPickerPanel` over the mockup's fixture tree (app▸website▸homepage, chord,
places; infra▸data-view; theme) with no-op callbacks; `tag-tree/path-chip`
in both states.

## 5. Data-view nested sections + the `tag` field type

### 5.1 Contract changes (`primitives/data-view/core`)

```ts
// grouping.ts
export interface GroupBucketAncestor { readonly key: string; readonly label: string; readonly order: number;
  readonly swatch?: string }
export interface GroupBucket { key; label; order;
  /** The bucket's ancestors, root first — present only when the grouping's buckets form a tree.
   *  Sections then nest: an ancestor is a section of its own even with no rows of its own. */
  readonly ancestors?: readonly GroupBucketAncestor[];
  /** A colour dot drawn before the label (user data, e.g. a tag's #rrggbb). */
  readonly swatch?: string;
}
// types.ts
export interface FieldOption { …; /** The option's own colour (#rrggbb, user data): group headers draw it as a dot. */ swatch?: string }
export interface DataViewSection<TRow> { …;
  /** Present only on a nested section: its depth (roots 0) and parent section key. */
  nesting?: { depth: number; parentKey: string | null };
  /** The bucket's `swatch`, drawn by the header as a dot before the label. */
  swatch?: string;
}
// section-count.ts
export function sumSectionCounts(counts: readonly SectionCount[]): SectionCount;  // exact iff all exact
```

### 5.2 Pipeline (`web/internal/use-data-view-sections.ts`)

- `partitionIntoSections` (in-memory path, `sectioning` undefined): if any
  bucket carries `ancestors`, build a key → node forest (ancestor nodes created
  with no rows), order each sibling level with the existing rule
  (`(order * dir) || seq`), emit **pre-order** with `nesting`; a section's
  `count` is its OWN rows at this point. The `None` section stays last at depth 0
  (no `nesting`). Sections with no rows in their subtree are never emitted.
- `declared` sectioning: unchanged (servers never send ancestors).
  `appearance` sectioning ignores `ancestors` (flat) — documented in the
  `GroupBucket.ancestors` doc; no live source groups by a `tag` field today.
- New pure `rollUpNestedCounts(sections)` runs **last** in
  `useDataViewSections` (after rank-order, aggregate and fold, which write own
  counts): a nested section's `count` = `sumSectionCounts(own + descendants)`.
  No-op when no section has `nesting`.
- `use-hierarchy-tree.ts` (hierarchy grouping) ignores `ancestors` (flat).

### 5.3 Rendering

- New pure helper `visibleSections(sections, collapsed)` (core): drops every
  section with a collapsed ancestor (via `nesting.parentKey`).
- `GroupedSections` renders `visibleSections(...)`; header and body of a
  nested section are indented `depth` steps (`treeRowIndentStyle` from
  `primitives/tree/web`, or the same 1rem step) and the body of depth ≥ 1
  carries the mockup's left hairline (`border-l` in the soft border token).
  Collapse state stays keyed by `section.key` (tag ids are unique).
- `DataViewGroupHeader`: draws `section.swatch` as a dot before the label;
  depth ≥ 1 headers use medium weight instead of semibold.
- Views: gallery, list, icons get it through `GroupedSections`. **Table**
  (`plugins/table`, `DataTableGroup`) applies `visibleSections` and the depth
  indent on its group row in the same phase — no view may show a collapsed
  parent's children.

### 5.4 The `tag` field type (`plugins/fields/plugins/tag`)

- core: `tagFieldType = defineFieldType<string>("tag")`, `tagIdentity`
  (label "Tag", icon `label`, `extends: enumFieldType` — cell, filter, inline
  editor reuse enum's, which read `field.options`). Template: `fields/plugins/rank`.
- web: `Fields.Identity(tagIdentity)`.
- `plugins/data-view-group`: `tagGroupings = [{ id: "tree", label: "Nested", oneBucketPerValue: true, plan }]`,
  contributed `DataViewSlots.Grouping({ match: "tag", companion: true, label: "Group by", groupings: tagGroupings })`.
  `plan({ field })` indexes `field.options` (index = pre-order position);
  bucket = `{ key: value, label: option.label, order: index, swatch, ancestors }`
  with ancestors walked through `parent` (cycle-safe, root first);
  a value naming no option → `null` (joins None).

## 6. Data model changes

### 6.1 Prototypes (`apps/prototypes/plugins/state`, new)

Core:

```ts
export const prototypeTagIdKind = defineIdKind({ prefix: "prtag", label: "Prototype tag" });
export const prototypeTagsEntityRef = tagTreeEntityRef("prototype_tags", { idKind: prototypeTagIdKind });
export const prototypeTags = liveCollection("prototypes.tags.all", tagTreeCollectionSpec(prototypeTagsEntityRef));
export const prototypeTagTree = defineTagTree({ id: "prototypes", entity: prototypeTagsEntityRef, collection: prototypeTags });

export const prototypeStateFields = {
  id: idKindField(protoIdKind),            // the prototype folder's id (hand-made folders have no state, as before)
  pinned: boolField(), done: boolField(),  // DB default false
  tagId: nullable(textField()),            // one tag of prototypeTagTree, or none
  createdAt: dateField(), updatedAt: dateField(),
};
export const prototypeStateEntityRef = entityRef("prototype_state", prototypeStateFields);
export const prototypeStates = liveCollection("prototypes.state.all", { from: prototypeStateEntityRef,
  carry: { pick: [all fields] }, id: "id", all: { orderBy: [["id","asc"]],
  unbounded: { reason: "one row per prototype the user marked; the gallery joins it onto the whole list it already holds" } } });
export type PrototypeState; export const NO_PROTOTYPE_STATE = { pinned: false, done: false, tagId: null };
export const PrototypeStateChangeSchema = z.object({ done: z.boolean().optional(),
  pinned: z.boolean().optional(), tagId: z.string().nullable().optional() }).refine(≥1 field);
export const setPrototypeState = defineEndpoint({ route: "PATCH /api/prototypes/:name/state", body: PrototypeStateChangeSchema });
```

Server `server/internal/tables.ts`: `defineTagTreeTable(prototypeTagsEntityRef)`
→ `_prototypeTags`; `defineEntity(prototypeStateEntityRef, { primaryKey: "id",
columns: { pinned/done default false, tagId: { references: { column: () =>
_prototypeTags.id, onDelete: "set null" } }, timestamps defaultNow }, updatedAt
touchedBy pinned/done/tagId })` → `_prototypeState`. Contributions:
`IdKinds.Kind({ kind: prototypeTagIdKind })` (server AND web), both
`serveCollection(...).declare`, `TagTrees.Tree(serveTagTree(prototypeTagTree,
{ table: _prototypeTags, carriers: [singleTagCarrier(_prototypeState, _prototypeState.tagId)] }))`,
the PATCH route, the import warm-up.

`PATCH /api/prototypes/:name/state`: 404 unless `protoIdKind.is(name)` and the
folder exists (move `prototypeExists` from `files/server/internal/status.ts`);
400 for a `tagId` not in `prototype_tags`; upsert
`INSERT … ON CONFLICT (id) DO UPDATE SET` only the given fields.

- A deleted folder's row stays (harmless: every consumer joins from
  `prototypesList`; a restored folder regains its state). No cleanup job.
- A deleted tag: its carriers get its parent (carrier), FK `SET NULL` is the backstop.
- No agent-write ledger: an E2E mutates its own worktree DB, never main's.

Web: `usePrototypeStates()` (useLive), `usePrototypeState(name)` (useLiveRow;
absent = `NO_PROTOTYPE_STATE`, pending stays pending), `useSetPrototypeState()`.

**One-time `_status` import** —
`state/server/internal/import-status-files.ts`, `defineWarmup({ name:
"prototypes.import-status-files", scope: "worktree" })`: in a transaction,
`LOCK TABLE prototype_state IN SHARE ROW EXCLUSIVE MODE`; if the table has any
row → return; else read `<prototypesDir.path>/_status/*.json` (skip `*.lock`
and names failing `protoIdKind.is`; parse `{ done?: boolean, pinned?: boolean }`
strictly — a malformed file throws, loud) and insert one row each with
`ON CONFLICT DO NOTHING`. Mirrors `seedPlaceTagsWarmup`: main imports on its
first boot after the push; a fork made after that inherits the rows and skips;
a fork made before (including the implementing worktree) imports itself. The
files are never deleted by code (other DBs still need them); file a follow-up
task "remove the `_status` import and the retired dir" once main has imported.

**Retire the file store** (in `files`): delete `core/status.ts` exports
(`PrototypeStatus*`, `prototypeStatuses`, `statusOf`, `setPrototypeStatus`,
`NO_PROTOTYPE_STATUS`, `applyPrototypeStatusChange`), `shared/status.ts` (+ its
test), `server/internal/status.ts` (route, served value, ledger), the
`status-recorded` / `status-internal` arms (`tree-path.ts`, `watcher.ts`),
`status.ts` from `files/exempt/index.ts`. Keep `_status` unserved and
unwatched as a retired name: `RETIRED_DIR_NAMES = ["_status"]` in
`files/shared/` used by `handlers.ts` `isInternalDir` and `tree-path.ts`
(`{ kind: "retired" }`, nothing to react to). `shared/record-store.ts` stays
(picks use it). CLI: `./equin prototype list` never read `_status`
(the `[done]` line in `files/CLAUDE.md` is stale) and stays backend-free —
it prints no state; delete that doc line.

**Gallery** (`apps/prototypes/plugins/gallery`):
- `PrototypeGalleryRow = PrototypeMeta & { done; pinned; tagId: string | null }`,
  joined from `usePrototypeStates()`; `useCombinedResources` adds
  `states` and `tags: useTagTree(prototypeTagTree)`.
- New field `{ id: "tag", label: "Tag", type: "tag", options: tagFieldOptions(tags), value: (p) => p.tagId, visible: false }`.
  Default view stays grouped by `status`.
- `set-status.ts` → `useSetPrototypeState` (state web); Pin/Done card and
  header actions read the joined row / `usePrototypeState(name)`.
- New `TagHeaderAction` (`components/tag-chip.tsx`):
  `TagPickerPopover` + `TagPathChip`, `offerNone`, counts =
  `rolledUpTagCounts(states of listed prototypes as [tagId], tags)`;
  contributed `prototypeDetailPane.Actions({ id: "tag", component: TagHeaderAction })`;
  `config/apps/prototypes/canvas/prototypes-detail.actions.jsonc`: insert
  `"apps.prototypes.gallery:tag"` right after `"primitives.pane:title"`.

**v2: `deletedAt` (after rebasing onto main's "deleted is a status, not a
move", `research/2026-10-24-apps-prototypes-status-trash.md`).** Main made a
delete a third `_status` field (`deletedAt`) instead of moving the folder to
`_trash/`. Decision: deleted lives in the DB like the rest — `prototype_state`
gains a nullable `deleted_at`; the `_status` store still goes away entirely.
- `state` owns `DELETE /api/prototypes/:name` (upsert, `COALESCE` keeps the
  first instant) and `POST /api/prototypes/:name/restore` (clear). Per
  instance: a delete in a worktree never deletes on main, so the
  `prototype-status` agent-write ledger is not ported (nothing host-global to
  revert).
- The one-time import reads `deletedAt` too. Main's table is empty at its first
  deploy, so main imports it; a worktree DB that imported earlier keeps its
  rows and never re-imports it (accepted).
- `adoptLegacyTrash` moves to `state` as a `host`-scope (main-only) warm-up:
  record deleted in main's DB at the folder's ctime, then rename back; it runs
  the import first (the import needs an empty table). `_trash` joins
  `RETIRED_DIR_NAMES`.
- The gallery's Trash pane, Delete / Restore actions and the canvas's deleted
  notice read `deletedAt` from the state rows (`Date`, not an ISO string).
- `./equin prototype list` stops filtering deleted prototypes: it runs with no
  backend, and the only DB read a CLI does today (`task-track`'s
  `checkoutTrack`, raw `pg`) would mean `files` hand-spelling `state`'s table —
  and `files` cannot import `state` (state → files already; a cycle). It lists
  every folder on disk, deleted ones included.

### 6.2 Places

Keep table `place_tags`, every id, every `places.tags` value. Changes:

- `placeTagsEntityRef = tagTreeEntityRef("place_tags", { idKind: placeTagIdKind,
  extraFields: { googleTypes: tagsField({ label: "Auto-set from Google types" }), role: nullable(enumTextField(TAG_ROLES)) } })`;
  `placeTagFields` export goes (callers use the ref's fields).
- `placeTags = liveCollection("places.tags.all", tagTreeCollectionSpec(placeTagsEntityRef, { listFields: ["googleTypes"] }))`
  (same key; wire `rank` becomes a string — no older bundle survives a
  deploy's rows, acceptable as for any wire change);
  `placeTagTree = defineTagTree({ id: "places", … })`.
- `tables.ts`: `defineTagTreeTable(placeTagsEntityRef, { columns: { googleTypes: { default: [] }, rank: { name: "tree_rank" } }, touchedBy: { googleTypes: true, role: true }, indexes: role unique partial index as today })`.
- **Rank migration** (one push, phased): the schema migration (name
  `place-tags-tree-rank`) must contain exactly: expand `ADD COLUMN tree_rank
  rank_text`, `CREATE INDEX place_tags_parent_rank_idx`; contract `ALTER
  COLUMN tree_rank SET NOT NULL`, `DROP COLUMN rank`. When drizzle-kit asks
  whether `tree_rank` is created or renamed, answer **create** (a rename would
  keep the integer type). Data migration (`./equin build
  --custom-migration --migration-name place-tags-fractional-rank`, hand-filled,
  claimed by the schema migration so it runs between expand and contract):

  ```sql
  WITH ordered AS (
    SELECT id, (row_number() OVER (PARTITION BY parent_id ORDER BY rank, created_at, id) - 1) AS n
    FROM place_tags)
  UPDATE place_tags t
  SET tree_rank = 'b'
    || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (o.n / 62)::int + 1, 1)
    || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', (o.n % 62)::int + 1, 1)
  FROM ordered o
  WHERE t.id = o.id AND t.tree_rank IS NULL;
  ```

  `b` + two base-62 digits is a valid `fractional-indexing` integer key, sorts
  in sibling order under C collation, and covers 3 844 siblings per parent
  (assert with `query_db` before building: `SELECT max(c) FROM (SELECT count(*) c FROM place_tags GROUP BY parent_id) x`).
  Idempotent (`tree_rank IS NULL`).
- Server: `TagTrees.Tree(serveTagTree(placeTagTree, { table: _placeTags,
  carriers: [placeTagsCarrier], editableExtras: ["googleTypes"],
  refuseDelete: (t) => t.role !== null ? \`The ${t.name} tag cannot be deleted\` : null }))`
  where `placeTagsCarrier` wraps today's jsonb loop + `replaceDeletedTag`
  (`tag-edits.ts`). Delete the places tag endpoints (`createPlaceTag`,
  `updatePlaceTag`, `deletePlaceTag` + bodies, handlers) and
  `tags-repo.ts`'s create/update/delete/nextRank (keep `listTags` /
  `requireTag` for place edits). `seedTagTree` mints ranks with
  `Rank.between(prevSibling, null)` per parent (mapstr `replace-all.ts` reuses it).
- Core helpers: `tag-tree.ts` keeps only Places semantics — `TAG_ROLES`,
  `tagIdByRole`, `isRoleTag`, `placeFlags`, `ringColors`, `mainColor`,
  `NEUTRAL_PLACE_COLOR`, `autoTagsFor`, `tagPlaceCounts` (=
  `rolledUpTagCounts(places.map(p => p.tags), tags)`) — over
  `PlaceTagNode = TagNode & { googleTypes; role }`; every generic helper is
  imported from the engine (no re-export — callers import the engine barrel).
- Web: `usePlaceTags` = `useTagTree(placeTagTree)`; `useCreate/Update/DeletePlaceTag`
  replaced by `useTagTreeActions(placeTagTree)` at call sites
  (`tag-manager-panel.tsx`, `tag-parent-select.tsx` → `move` with
  `{ parentId, targetId: null, zone: "after" }`, `places-screen.tsx`).
  `TagMark` → `tag-tree/picker` (delete tag-manager's copy and its export);
  `TAG_PALETTE` → engine core (delete `tag-manager/web/internal/palette.ts`).
  `places-map/web/components/tag-picker.tsx` becomes a thin wrapper:
  `TagPickerPopover` with `exclude: (t) => isRoleTag(t.id, tags) || place.tags.includes(t.id)`,
  `counts = tagPlaceCounts(places, tags)`, trigger = today's dashed `＋ Tag` button.
  `tagPathLabel` in `tag-chip.tsx` → engine's (with `" › "`).
  `places-map/web/internal/fields.tsx` `tagOptions` → `tagFieldOptions`.
  The sidebar keeps its own tree UI but uses the engine helpers.

## 7. Phases

Shared checkout: **one `./equin build` at a time.** Phase 1 has no
schema change; Phase 2 phases each generate a migration, so they run in
sequence.

| Phase | Depends on | Parallel with |
|---|---|---|
| 1A tag-tree engine + picker | — | 1B |
| 1B data-view nested sections + `fields/tag` | — | 1A |
| 2A prototypes state, tags, import, UI, docs | 1A, 1B | — (2B waits for 2A's green build) |
| 2B places onto the generator + rank migration | 1A, 2A built | — |

**1A** — create `plugins/tag-tree/{CLAUDE.md,package.json}`,
`plugins/tag-tree/plugins/engine/{core,server,web}`,
`plugins/tag-tree/plugins/picker/{web,exhibits}`. Move the generic helpers and
their tests out of `places-core/core/internal/tag-tree.ts` by copy (Places
switches in 2B; until then both exist). Tests: `engine/core` helpers
(port `tag-tree.test.ts`; add `resolveTagPath`, `parseTagPath`,
`rolledUpTagCounts`, `tagFieldOptions`); `engine/server` handler tests over a
throwaway DB (`database/db-test-fixture`) with a test-only tree + single carrier:
create (dup sibling → 400), createPath reuse/case-insensitive, move
before/after/inside + cycle → 400, delete re-ranks children at the tag's
position and rewrites carriers, `refuseDelete`, unknown tree → 404; picker
jsdom tests for `TagPickerPanel` (filter, create row bolding, No tag, pick).
Build once at the end (registries, docs).

**1B** — edits in `primitives/data-view/core/internal/{grouping,types,section-count}.ts`,
`web/internal/{use-data-view-sections,grouped-sections,group-header}.tsx?`,
`plugins/table/…` group rows, `web/internal/hierarchy/use-hierarchy-tree.ts`
(ignore ancestors); new `plugins/fields/plugins/tag` (+ `data-view-group`).
Tests: `use-data-view-sections.test.ts` (nested emission order, ancestor
sections with no own rows, rolled counts incl. atLeast, None last, desc
order per level, fold/aggregate then roll-up), `grouped-sections.test.tsx`
(collapsing a parent hides descendants; children fold independently), tag
grouping unit test (ancestors, unknown → null, cycle-safe). Data-view's
`CLAUDE.md`: document nesting.

**2A** — new `apps/prototypes/plugins/state` (§6.1), gallery changes, files
retirement, jsonc order. Build with `--migration-name prototype-state-and-tags`.
Docs: `apps/prototypes/CLAUDE.md` (add `state`; state the files-global /
state-per-instance model), `files/CLAUDE.md` (drop Status section and
`[done]` line; note `_status` retired), `gallery/CLAUDE.md`, new
`state/CLAUDE.md`, root `prototypes/CLAUDE.md` (one line: pin/done/tag are
per-instance DB state, files are shared). `add_task` the import-removal
follow-up.

**2B** — §6.2; build with `--migration-name place-tags-tree-rank` after
creating the data migration. Delete the copied generic helpers from
places-core; update `places-core`, `tag-manager`, `places-map` CLAUDE.md.

## 8. Verification (each phase, before handing back)

1. `./equin test plugins/tag-tree` · `plugins/primitives/plugins/data-view` ·
   `plugins/fields/plugins/tag` · `plugins/apps/plugins/prototypes` ·
   `plugins/apps/plugins/places`.
2. `./equin check` (boundaries, registries, docs, migrations,
   `data-migration-dml-only`, `migration-phases-valid`, `migration-applies-clean`).
3. `./equin build` (backgrounded; a subagent then
   `./equin await <op>` in the foreground).
4. `query_db`: 2A — `prototype_state` row count equals the `_status/*.json`
   count; 2B — `place_tags` row count and ids unchanged, `tree_rank` order
   per parent equals the old order, `places.tags` untouched.
5. UI (`browser_*` tools on the worktree build, then screenshots):
   - `/prototypes/proto/<id>`: chip after the title, popover tree, search →
     `Create a / b / c`, drag reorder/nest, ⋯ menu, No tag.
   - `/prototypes`: Group → Tag shows nested sections with rolled-up counts,
     parent rows above child sections, independent folds, None last.
   - Places map: `＋ Tag` opens the shared picker, role tags absent, tags
     already on the place absent; tag manager still edits Google types.
   - `./equin run plugins/plugin-meta/plugins/exhibits/e2e/exhibit-shot.ts --id tag-tree/picker`.
   - Compare against the mockup:
     `./equin run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts --name proto-1792526257-f0gpsa`
     where it declares `mocks` (otherwise side-by-side screenshots).
   Add `apps/prototypes/plugins/gallery/e2e/tag-grouping.ts` (set a tag
   through the PATCH, group by Tag, assert nested headers and counts) — it
   writes the worktree's own DB only.

## 9. Rejected (short)

- **Per-tree endpoints / per-tree live keys minted by the generator** —
  endpoint routes and live keys must be literals for the resource and route
  scanners; one endpoint set keyed by `:tree` + a server registry needs no
  per-tree spelling.
- **Keeping `rank` as an integer** — the repo's ordering primitive is the
  fractional `Rank` with server-minted ranks from anchors; int ranks made
  every reorder a renumbering.
- **Nesting as a tag-specific data-view feature** — nesting is a property of
  buckets (`ancestors`), so any forest-shaped option set (Places tags filter
  vocabulary, future trees) gets it.
- **Out of scope**: page tags (`page/plugins/tags`, flat) stay as they are; a
  `tag` "is under" filter operator; grouping a multi-tag (`tags`) field.

## 10. Open risks

- drizzle-kit's create-vs-rename prompt for `tree_rank` (§6.2): answering
  "rename" silently keeps an int column. Inspect the generated SQL.
- `useTreeModel`'s DnD may be handle-only; whole-row drag may need a
  `primitives/tree` option (1A).
- `tagTreeCollectionSpec` generic typing vs `liveCollection`'s `pick`/`carry`
  inference — inline the literal if needed.
- Sticky stacking of many nested headers degrades to the swap hand-off past
  the stack cap — acceptable, already the policy.
