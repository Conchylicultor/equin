import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  isTagUnder,
  parseTagPath,
  resolveTagPath,
  tagPath,
  tagPathLabel,
  type TagRow,
} from "@plugins/tag-tree/plugins/engine/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import type { ExpandChange } from "@plugins/primitives/plugins/tree/core";
import {
  TreeDropZones,
  TreeProvider,
  TreeRowChrome,
  useTreeModel,
  useTreeRow,
} from "@plugins/primitives/plugins/tree/web";
import { RankReorderDndContext } from "@plugins/primitives/plugins/rank-reorder/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  cn,
  Separator,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { TagMark } from "./tag-mark";
import { fireWrite } from "../internal/surfaced";
import type { TagPickerOptions, TagPickerWrites } from "../internal/types";
import { TagNameInput } from "./tag-name-input";
import { TagRowMenu } from "./tag-row-menu";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";

const addIcon = symbol("add");
const checkIcon = symbol("check");
const removeIcon = symbol("remove");

export interface TagPickerPanelProps<
  Row extends TagRow = TagRow,
> extends TagPickerOptions<Row> {
  /** The tree's rows (any order: the panel walks `parentId` / `rank`). */
  tags: readonly Row[];
  writes: TagPickerWrites;
  /** What the tree adds at the foot of a row's ⋯ menu (its own extras, read-only). */
  rowMenuExtra?: (tag: Row) => ReactNode;
}

/** How one row is marked: picked, negated, holding either, or none. */
type Mark = "picked" | "negated" | "partial" | "off";

/** The id of the inline row a new tag is typed into. */
const DRAFT_ID = "\u0000draft";

/** A tree line the panel paints: a tag adapted to the tree primitive's row. */
interface PickerRow<Row extends TagRow> {
  id: string;
  parentId: string | null;
  rank: Rank;
  expanded: boolean;
  /** The tag, or null for the draft row. */
  tag: Row | null;
  /** Shown, but not pickable (an excluded tag holding a pickable one). */
  dimmed: boolean;
}

/**
 * The tag picker, pure: props in, callbacks out. An empty query shows the
 * foldable tree (drag a row to reorder or nest it, hover for ＋ and ⋯,
 * double-click to rename); a query lists every tag whose path contains it and
 * offers to create the typed path. No instructional text — the mockup's.
 */
export function TagPickerPanel<Row extends TagRow>({
  tags,
  writes,
  selected,
  negated = NONE,
  indicator = "check",
  defaultExpanded = "all",
  autoFocus = true,
  pickCreated = true,
  canDelete,
  rowMenuExtra,
  exclude,
  counts,
  offerNone = false,
  onPick,
}: TagPickerPanelProps<Row>) {
  const [query, setQuery] = useState("");
  // The set holds the folded tags: none at first, or every tag below the
  // roots (`defaultExpanded: "roots"`).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() =>
    defaultExpanded === "all"
      ? new Set()
      : new Set(tags.filter((t) => t.parentId !== null).map((t) => t.id)),
  );
  const markOf = useMarks(tags, selected, negated);
  /** The inline new-tag row: under which parent (null = a root). */
  const [draftParent, setDraftParent] = useState<string | null | undefined>(
    undefined,
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const visible = useMemo(() => visibleTags(tags, exclude), [tags, exclude]);
  const needle = query.trim();
  const searching = parseTagPath(needle).length > 0;

  const openDraft = useCallback((parentId: string | null) => {
    setQuery("");
    setRenamingId(null);
    setDraftParent(parentId);
    if (parentId !== null) {
      setCollapsed((s) => {
        const next = new Set(s);
        next.delete(parentId);
        return next;
      });
    }
  }, []);

  const commitDraft = useCallback(
    (name: string) => {
      const parentId = draftParent ?? null;
      setDraftParent(undefined);
      if (name === "") return;
      fireWrite(writes.create({ name, parentId }));
    },
    [draftParent, writes],
  );

  const commitRename = useCallback(
    (id: string, name: string) => {
      setRenamingId(null);
      const tag = tags.find((t) => t.id === id);
      if (!tag || name === "" || name === tag.name) return;
      fireWrite(writes.update(id, { name }));
    },
    [tags, writes],
  );

  const createPath = useCallback(
    async (segments: readonly string[]) => {
      const { id } = await writes.createPath(segments);
      if (pickCreated) onPick(id);
    },
    [writes, onPick, pickCreated],
  );

  return (
    // `data-tag-picker`: the panel's identity on the DOM (e2e scripts find
    // its rows as `[data-tag-picker] [data-tree-id]`).
    <Stack direction="col" gap="none" data-tag-picker>
      <SearchInput
        appearance="menu"
        autoFocus={autoFocus}
        value={query}
        placeholder="Search or create…"
        aria-label="Search or create a tag"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !searching) return;
          e.preventDefault();
          const segments = parseTagPath(needle);
          const exact = findByPath(segments, tags);
          if (exact === undefined) fireWrite(createPath(segments));
          else if (visible.pickable.has(exact.id)) onPick(exact.id);
        }}
      />
      <Separator />
      <Stack direction="col" gap="none" className="p-2xs">
        {searching ? (
          <SearchResults
            query={needle}
            tags={tags}
            pickable={visible.pickable}
            markOf={markOf}
            indicator={indicator}
            counts={counts}
            onPick={onPick}
            onCreate={createPath}
          />
        ) : (
          <>
            {offerNone && selected.length > 0 ? (
              <NoTagRow onPick={() => onPick(null)} />
            ) : null}
            <TagTreeBody
              tags={tags}
              visible={visible}
              collapsed={collapsed}
              setCollapsed={setCollapsed}
              draftParent={draftParent}
              renamingId={renamingId}
              markOf={markOf}
              indicator={indicator}
              counts={counts}
              writes={writes}
              canDelete={canDelete}
              rowMenuExtra={rowMenuExtra}
              onPick={onPick}
              onAddChild={openDraft}
              onRename={setRenamingId}
              onCommitDraft={commitDraft}
              onCommitRename={commitRename}
            />
          </>
        )}
      </Stack>
      {searching ? null : (
        <>
          <Separator />
          <Stack direction="col" gap="none" className="p-2xs">
            <FooterRow onClick={() => openDraft(null)} />
          </Stack>
        </>
      )}
    </Stack>
  );
}

// ── Marks ─────────────────────────────────────────────────────────────────

const NONE: readonly string[] = [];

/**
 * Each tag's mark: picked, negated, else partial while a picked or negated
 * tag sits under it (derived — every ancestor of one).
 */
function useMarks(
  tags: readonly TagRow[],
  selected: readonly string[],
  negated: readonly string[],
): (tagId: string) => Mark {
  return useMemo(() => {
    const picked = new Set(selected);
    const neg = new Set(negated);
    const partial = new Set<string>();
    for (const id of [...selected, ...negated]) {
      for (const ancestor of tagPath(id, tags).slice(0, -1)) {
        partial.add(ancestor.id);
      }
    }
    return (id: string) =>
      picked.has(id)
        ? "picked"
        : neg.has(id)
          ? "negated"
          : partial.has(id)
            ? "partial"
            : "off";
  }, [tags, selected, negated]);
}

// ── Visibility ────────────────────────────────────────────────────────────

interface Visible {
  /** Every tag shown in the tree (pickable or dimmed). */
  shown: ReadonlySet<string>;
  /** The shown tags a click picks. */
  pickable: ReadonlySet<string>;
}

/** Pickable = not excluded; an excluded tag stays (dimmed) only above a pickable one. */
function visibleTags<Row extends TagRow>(
  tags: readonly Row[],
  exclude: ((tag: Row) => boolean) | undefined,
): Visible {
  const pickable = new Set(tags.filter((t) => !exclude?.(t)).map((t) => t.id));
  const shown = new Set(pickable);
  for (const id of pickable) {
    for (const ancestor of tagPath(id, tags)) shown.add(ancestor.id);
  }
  return { shown, pickable };
}

/** The tag whose whole path is `segments` (case-insensitive), if any. */
function findByPath(
  segments: readonly string[],
  tags: readonly TagRow[],
): TagRow | undefined {
  const resolved = resolveTagPath(segments, tags);
  const leaf = resolved.at(-1)?.tagId;
  return leaf === null || leaf === undefined
    ? undefined
    : tags.find((t) => t.id === leaf);
}

// ── The tree (empty query) ─────────────────────────────────────────────────

interface TagTreeBodyProps<Row extends TagRow> {
  tags: readonly Row[];
  visible: Visible;
  collapsed: ReadonlySet<string>;
  setCollapsed: (
    update: (prev: ReadonlySet<string>) => ReadonlySet<string>,
  ) => void;
  draftParent: string | null | undefined;
  renamingId: string | null;
  markOf: (tagId: string) => Mark;
  indicator: "check" | "checkbox";
  counts: ReadonlyMap<string, number> | undefined;
  writes: TagPickerWrites;
  canDelete: ((tag: Row) => boolean) | undefined;
  rowMenuExtra: ((tag: Row) => ReactNode) | undefined;
  onPick(tagId: string): void;
  onAddChild(parentId: string): void;
  onRename(id: string): void;
  onCommitDraft(name: string): void;
  onCommitRename(id: string, name: string): void;
}

function TagTreeBody<Row extends TagRow>({
  tags,
  visible,
  collapsed,
  setCollapsed,
  draftParent,
  renamingId,
  markOf,
  indicator,
  counts,
  writes,
  canDelete,
  rowMenuExtra,
  onPick,
  onAddChild,
  onRename,
  onCommitDraft,
  onCommitRename,
}: TagTreeBodyProps<Row>) {
  const rows = useMemo(() => {
    const out: PickerRow<Row>[] = tags
      .filter((t) => visible.shown.has(t.id))
      .map((t) => ({
        id: t.id,
        parentId: t.parentId,
        rank: Rank.from(t.rank),
        expanded: !collapsed.has(t.id),
        tag: t,
        dimmed: !visible.pickable.has(t.id),
      }));
    if (draftParent !== undefined) {
      // Last among its siblings — where the server appends the new tag.
      const last = tags
        .filter((t) => t.parentId === draftParent)
        .reduce<string | null>(
          (max, t) => (max === null || t.rank > max ? t.rank : max),
          null,
        );
      out.push({
        id: DRAFT_ID,
        parentId: draftParent,
        rank: Rank.between(last === null ? null : Rank.from(last), null),
        expanded: false,
        tag: null,
        dimmed: false,
      });
    }
    return out;
  }, [tags, visible, collapsed, draftParent]);

  const applyExpanded = useCallback(
    (changes: readonly ExpandChange[]) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        for (const c of changes) {
          if (c.expanded) next.delete(c.id);
          else next.add(c.id);
        }
        return next;
      }),
    [setCollapsed],
  );

  const pick = useCallback(
    (id: string) => {
      if (visible.pickable.has(id)) onPick(id);
    },
    [visible, onPick],
  );

  const model = useTreeModel<PickerRow<Row>>({
    rows,
    onSelect: pick,
    setExpanded: applyExpanded,
    onMove: (id, dest) => fireWrite(writes.move(id, dest)),
    onOpen: onRename,
    // A dimmed row only folds: it is there to reach what is under it.
    expandOnActivate: (row) => row.dimmed,
    revealSelected: false,
    canCreate: false,
    dragOverlay: (row) => row.tag?.name ?? "",
  });

  return (
    <TreeProvider value={model.context}>
      <RankReorderDndContext
        onDragEnd={model.onDragEnd}
        dragOverlay={model.dragChip}
      >
        {(activeId) =>
          model.flat.map((line) =>
            line.kind !== "node" ? null : line.node.tag === null ? (
              <DraftRow
                key={line.node.id}
                depth={line.depth}
                onCommit={onCommitDraft}
              />
            ) : (
              <TagTreeRow
                key={line.node.id}
                node={line.node}
                tag={line.node.tag}
                depth={line.depth}
                tags={tags}
                activeId={activeId}
                mark={markOf(line.node.id)}
                indicator={indicator}
                renaming={renamingId === line.node.id}
                count={counts?.get(line.node.id)}
                showCount={counts !== undefined}
                writes={writes}
                deletable={canDelete?.(line.node.tag) ?? true}
                menuExtra={rowMenuExtra?.(line.node.tag)}
                onAddChild={onAddChild}
                onRename={onRename}
                onCommitRename={onCommitRename}
              />
            ),
          )
        }
      </RankReorderDndContext>
    </TreeProvider>
  );
}

function TagTreeRow<Row extends TagRow>({
  node,
  tag,
  depth,
  tags,
  activeId,
  mark,
  indicator,
  renaming,
  count,
  showCount,
  writes,
  deletable,
  menuExtra,
  onAddChild,
  onRename,
  onCommitRename,
}: {
  node: Parameters<typeof useTreeRow<PickerRow<Row>>>[0];
  tag: Row;
  depth: number;
  tags: readonly Row[];
  activeId: string | null;
  mark: Mark;
  indicator: "check" | "checkbox";
  renaming: boolean;
  count: number | undefined;
  showCount: boolean;
  writes: TagPickerWrites;
  deletable: boolean;
  menuExtra: ReactNode;
  onAddChild(parentId: string): void;
  onRename(id: string): void;
  onCommitRename(id: string, name: string): void;
}) {
  const controls = useTreeRow(node);
  // A drag never lands on itself or under itself: no indicator there.
  const droppable =
    activeId !== null &&
    activeId !== tag.id &&
    !isTagUnder(tag.id, activeId, tags);
  const rowRef = useCallback(
    (el: HTMLDivElement | null) => {
      controls.childRef(el);
      controls.dragSource.ref(el);
    },
    [controls],
  );
  const draggable = !renaming;
  const selected = mark === "picked";
  return (
    <TreeRowChrome
      rowId={tag.id}
      depth={depth}
      hasChildren={controls.hasChildren}
      isOpen={controls.isOpen}
      selected={selected}
      onToggle={controls.toggleExpanded}
      onSelect={renaming ? undefined : controls.select}
      onOpen={renaming ? undefined : controls.open}
      rowRef={rowRef}
      dragAttributes={draggable ? controls.dragSource.attributes : undefined}
      dragListeners={draggable ? controls.dragSource.listeners : undefined}
      className={cn(
        controls.isDragging && "opacity-40",
        node.dimmed && "text-muted-foreground",
        droppable && controls.isOverChild && "ring-1 ring-primary ring-inset",
      )}
      actions={
        renaming ? undefined : (
          <>
            <IconButton
              icon={addIcon}
              label="Add sub-tag"
              onClick={() => onAddChild(tag.id)}
            />
            <TagRowMenu
              tag={tag}
              tags={tags}
              writes={writes}
              deletable={deletable}
              extra={menuExtra}
              onRename={() => onRename(tag.id)}
              onAddChild={() => onAddChild(tag.id)}
            />
          </>
        )
      }
    >
      {droppable ? (
        <TreeDropZones
          beforeRef={controls.beforeRef}
          afterRef={controls.afterRef}
          isOverBefore={controls.isOverBefore}
          isOverAfter={controls.isOverAfter}
        />
      ) : null}
      {indicator === "checkbox" ? <MarkBox mark={mark} /> : null}
      <TagMark tag={tag} tags={tags} />
      <Fill>
        {renaming ? (
          <TagNameInput
            initial={tag.name}
            placeholder={tag.parentId === null ? "Tag name" : "Sub-tag name"}
            onCommit={(name) => onCommitRename(tag.id, name)}
          />
        ) : (
          <TagName name={tag.name} mark={mark} empty={showCount && !count} />
        )}
      </Fill>
      {showCount && !renaming ? (
        <Text variant="count" tone="faint">
          {count ? String(count) : ""}
        </Text>
      ) : null}
      {indicator === "check" && selected && !renaming ? <Check /> : null}
    </TreeRowChrome>
  );
}

/** The inline row a new tag is named in: Enter / blur creates it, blank discards it. */
function DraftRow({
  depth,
  onCommit,
}: {
  depth: number;
  onCommit(name: string): void;
}) {
  return (
    <TreeRowChrome depth={depth} hasChildren={false} isOpen={false}>
      <TagDot />
      <Fill>
        <TagNameInput
          initial=""
          placeholder={depth === 0 ? "Tag name" : "Sub-tag name"}
          onCommit={onCommit}
        />
      </Fill>
    </TreeRowChrome>
  );
}

// ── Search results (a query) ──────────────────────────────────────────────

function SearchResults({
  query,
  tags,
  pickable,
  markOf,
  indicator,
  counts,
  onPick,
  onCreate,
}: {
  query: string;
  tags: readonly TagRow[];
  pickable: ReadonlySet<string>;
  markOf: (tagId: string) => Mark;
  indicator: "check" | "checkbox";
  counts: ReadonlyMap<string, number> | undefined;
  onPick(tagId: string): void;
  onCreate(segments: readonly string[]): Promise<void>;
}) {
  // Typed as a path ("app/web") or a bare name ("web"): matched against each
  // tag's full path spelled the same way, the last segment highlighted.
  const segments = parseTagPath(query);
  const needle = segments.join(" / ").toLowerCase();
  const lower = (segments.at(-1) ?? "").toLowerCase();
  const matches = tags
    .filter((t) => pickable.has(t.id))
    .map((t) => ({ tag: t, path: tagPathLabel(t.id, tags) }))
    .filter((m) => m.path.toLowerCase().includes(needle))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const exact = findByPath(segments, tags);
  const resolved = resolveTagPath(segments, tags);
  return (
    <>
      {matches.map(({ tag }) => (
        <TreeRowChrome
          key={tag.id}
          rowId={tag.id}
          depth={0}
          hasChildren={false}
          isOpen={false}
          selected={markOf(tag.id) === "picked"}
          onSelect={() => onPick(tag.id)}
        >
          {indicator === "checkbox" ? <MarkBox mark={markOf(tag.id)} /> : null}
          <TagMark tag={tag} tags={tags} />
          <Fill>
            <Text>
              <PathLabel tagId={tag.id} tags={tags} highlight={lower} />
            </Text>
          </Fill>
          {counts ? (
            <Text variant="count" tone="faint">
              {counts.get(tag.id) ? String(counts.get(tag.id)) : ""}
            </Text>
          ) : null}
          {indicator === "check" && markOf(tag.id) === "picked" ? (
            <Check />
          ) : null}
        </TreeRowChrome>
      ))}
      {exact === undefined ? (
        <TreeRowChrome
          depth={0}
          hasChildren={false}
          isOpen={false}
          onSelect={() => fireWrite(onCreate(segments))}
        >
          <Icon icon={addIcon} className="size-4 text-muted-foreground" />
          <Fill>
            <Text tone="muted">
              Create{" "}
              {resolved.map((s, i) => (
                <span key={i}>
                  {i > 0 ? (
                    <span className="text-faint-foreground"> / </span>
                  ) : null}
                  {s.tagId === null ? (
                    <b className="font-medium text-strong-foreground">
                      {s.name}
                    </b>
                  ) : (
                    <span>{s.name}</span>
                  )}
                </span>
              ))}
            </Text>
          </Fill>
        </TreeRowChrome>
      ) : null}
    </>
  );
}

/** `anc / anc / leaf`, ancestors muted, the query's first match in each name marked. */
function PathLabel({
  tagId,
  tags,
  highlight,
}: {
  tagId: string;
  tags: readonly TagRow[];
  highlight: string;
}) {
  const path = tagPath(tagId, tags);
  return (
    <>
      {path.map((t, i) => (
        <span key={t.id}>
          {i > 0 ? <span className="text-faint-foreground"> / </span> : null}
          <span
            className={
              i < path.length - 1 ? "text-muted-foreground" : undefined
            }
          >
            <Highlighted text={t.name} needle={highlight} />
          </span>
        </span>
      ))}
    </>
  );
}

function Highlighted({
  text,
  needle,
}: {
  text: string;
  needle: string;
}): ReactNode {
  const at = needle === "" ? -1 : text.toLowerCase().indexOf(needle);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-primary-text">
        {text.slice(at, at + needle.length)}
      </mark>
      {text.slice(at + needle.length)}
    </>
  );
}

// ── Small rows ────────────────────────────────────────────────────────────

function NoTagRow({ onPick }: { onPick(): void }) {
  return (
    <TreeRowChrome
      depth={0}
      hasChildren={false}
      isOpen={false}
      onSelect={onPick}
    >
      <TagDot />
      <Fill>
        <Text tone="muted">No tag</Text>
      </Fill>
    </TreeRowChrome>
  );
}

function FooterRow({ onClick }: { onClick(): void }) {
  return (
    <TreeRowChrome
      depth={0}
      hasChildren={false}
      isOpen={false}
      onSelect={onClick}
    >
      <Icon icon={addIcon} className="size-4 text-muted-foreground" />
      <Fill>
        <Text tone="muted">New tag</Text>
      </Fill>
    </TreeRowChrome>
  );
}

/** The dashed ring a tag with no colour wears — "no tag", a tag being named. */
function TagDot() {
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 rounded-full border border-dashed border-muted-foreground"
    />
  );
}

/** A tag's name: struck in the destructive tone when negated, faint when it counts nothing. */
function TagName({
  name,
  mark,
  empty,
}: {
  name: string;
  mark: Mark;
  empty: boolean;
}) {
  if (mark === "negated") {
    return (
      <Text tone="destructive" className="line-through">
        {name}
      </Text>
    );
  }
  return <Text tone={empty ? "faint" : "default"}>{name}</Text>;
}

/** The leading box of a `checkbox` picker: ✓ picked, − negated, a primary − when a tag under it is either. */
function MarkBox({ mark }: { mark: Mark }) {
  return (
    <Center
      as="span"
      aria-hidden
      data-mark={mark}
      className={cn(
        "size-3.5 rounded-sm border",
        mark === "picked" &&
          "border-primary bg-primary text-primary-foreground",
        mark === "negated" &&
          "border-destructive bg-destructive text-primary-foreground",
        mark === "partial" && "border-primary text-primary-text",
        mark === "off" && "border-border",
      )}
    >
      {mark === "picked" ? (
        <Icon icon={checkIcon} className="size-3" />
      ) : mark === "negated" || mark === "partial" ? (
        <Icon icon={removeIcon} className="size-3" />
      ) : null}
    </Center>
  );
}

function Check() {
  return <Icon icon={checkIcon} className="size-4 text-primary-text" />;
}
