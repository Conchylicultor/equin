import { useMemo, useState, type ReactNode } from "react";
import {
  useDataViewControls,
  useFlatRows,
  useRowFilter,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import {
  Button,
  Input,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { useDraft } from "@plugins/primitives/plugins/persistent-draft/web";
import {
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleProvider,
  CollapsibleTrigger,
  useCollapsibleContext,
} from "@plugins/primitives/plugins/collapsible/web";
import {
  flattenTagTree,
  tagDescendants,
  tagPlaceCounts,
  type Place,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import { TagMark } from "@plugins/apps/plugins/places/plugins/tag-manager/web";
import {
  applySidebarState,
  cycleTag,
  hasPickedDescendant,
  removeTag,
  sidebarState,
  tagFilterState,
  withoutSidebarRules,
  type IncludeMode,
  type SidebarState,
  type TagFilterState,
} from "../internal/sidebar-filter";
import { AppShellBrand } from "@plugins/primitives/plugins/app-shell/web";
import { placeSearchText } from "../internal/fields";
import { TagChip } from "./tag-chip";

const checkIcon = symbol("check");
const removeIcon = symbol("remove");
const addIcon = symbol("add");
const tuneIcon = symbol("tune");

/** One tree level's indent, in px. */
const INDENT_PX = 14;

const MODE_OPTIONS = [
  { id: "any", label: "any", title: "A place with any of these tags" },
  { id: "all", label: "all", title: "A place with every one of these tags" },
] as const satisfies readonly {
  id: IncludeMode;
  label: string;
  title: string;
}[];

export interface TagSidebarProps {
  /** Every saved place (the faceted counts run over them). */
  places: readonly Place[];
  /** The whole tag tree. */
  tags: readonly PlaceTag[];
  /** "+ New tag": make one and open the tag manager on it. */
  onNewTag: () => Promise<void>;
  /** "Manage tags": open the tag manager. */
  onManageTags: () => void;
}

/**
 * The Places surface's `aside`: the tag tree, and the tag half of the view
 * filter. It reads and writes the active view's filter through
 * `useDataViewControls()` — the filter is the one source of truth, and the
 * sidebar owns only its top-level nested-tags rules (`sidebar-filter.ts`).
 *
 * Header: the app launcher (the app's mark), then "Places" and the total —
 * a click on those folds the sidebar to its header
 * (remembered per device) — then the "Tagged / Not tagged" summary with the
 * any / all switch and Clear (once anything is picked), shown folded too, so
 * an active tag filter never hides. Body: a tag search and the tree, each
 * row's count being how many places the REST of the filter keeps that carry
 * the tag or a tag nested under it. A click cycles
 * include → exclude → off. Footer: + New tag, Manage tags.
 */
export function TagSidebar({
  places,
  tags,
  onNewTag,
  onManageTags,
}: TagSidebarProps) {
  const { filter: controller, fields, activeState } = useDataViewControls();
  const { filter, setFilter, resolveOperatorSet } = controller;
  const state = useMemo(() => sidebarState(filter), [filter]);
  const write = (next: SidebarState) =>
    setFilter(applySidebarState(filter, next));

  // The header's count: the places the view shows now (filter and search, as
  // the views apply them) out of every saved place.
  const shown = useFlatRows(
    places,
    fields as FieldDef<Place>[],
    activeState,
    resolveOperatorSet,
    placeSearchText,
  ).length;

  // Faceted counts: the rows the rest of the view filter keeps.
  const rest = useMemo(() => withoutSidebarRules(filter), [filter]);
  const keep = useRowFilter(rest, fields, resolveOperatorSet);
  const counts = useMemo(
    () => tagPlaceCounts(keep ? places.filter(keep) : places, tags),
    [keep, places, tags],
  );

  const byId = useMemo(
    () => new Map<string, PlaceTag>(tags.map((t) => [t.id, t])),
    [tags],
  );
  const picked = (ids: readonly string[]) =>
    ids.map((id) => byId.get(id)).filter((t): t is PlaceTag => !!t);
  const [open, setOpen] = useDraft("places.tag-sidebar.open", true);

  return (
    // One fold for the tree and the footer: both slide away together under the
    // header, which stays (with the filter summary, so a filter never hides).
    <CollapsibleProvider open={open} onOpenChange={setOpen}>
      {/* `fill`: the floating aside card hugs this column's height up to the
          surface's, so the tree scrolls between a header and footer that stay put. */}
      <Column
        fill
        className="w-72"
        header={
          <Stack gap="sm" className="p-sm">
            {/* The launcher is a button of its own, so it sits beside the
                fold trigger rather than inside it. */}
            <Line className="gap-2xs">
              <AppShellBrand form="icon" />
              <Fill>
                <CollapsibleTrigger
                  aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
                  className="gap-sm rounded-md p-xs hover:bg-hover-fill"
                >
                  <Fill>
                    <Text variant="heading">Places</Text>
                  </Fill>
                  <PlaceCount shown={shown} total={places.length} />
                  <CollapsibleChevron className="size-4 text-muted-foreground" />
                </CollapsibleTrigger>
              </Fill>
            </Line>
            {state.include.length + state.exclude.length > 0 ? (
              <FilterSummary
                include={picked(state.include)}
                exclude={picked(state.exclude)}
                mode={state.mode}
                tags={tags}
                onRemove={(id) => write(removeTag(state, id))}
                onMode={(mode) => write({ ...state, mode })}
                onClear={() => write({ include: [], exclude: [], mode: "any" })}
              />
            ) : null}
          </Stack>
        }
        body={
          <CollapsibleContent>
            <TagTree
              tags={tags}
              counts={counts}
              state={state}
              onCycle={(id) => write(cycleTag(state, id, tags))}
            />
          </CollapsibleContent>
        }
        footer={
          <CollapsibleContent>
            <Line className="gap-2xs border-t p-xs">
              <Button variant="ghost" onClick={onNewTag}>
                <Icon icon={addIcon} />
                New tag
              </Button>
              <Fill />
              <Button variant="ghost" onClick={onManageTags}>
                <Icon icon={tuneIcon} />
                Manage tags
              </Button>
            </Line>
          </CollapsibleContent>
        }
      />
    </CollapsibleProvider>
  );
}

function FilterSummary(props: {
  include: PlaceTag[];
  exclude: PlaceTag[];
  mode: IncludeMode;
  tags: readonly PlaceTag[];
  onRemove: (tagId: string) => void;
  onMode: (mode: IncludeMode) => void;
  onClear: () => void;
}): ReactNode {
  const { include, exclude, mode, tags, onRemove, onMode, onClear } = props;
  return (
    <Surface level="sunken" className="rounded-lg p-sm">
      <Stack gap="xs">
        {include.length > 0 ? (
          <Cluster gap="xs">
            <Text variant="caption" tone="muted">
              Tagged
            </Text>
            {include.map((t) => (
              <TagChip
                key={t.id}
                tag={t}
                tags={tags}
                onRemove={() => onRemove(t.id)}
              />
            ))}
            {include.length > 1 ? (
              <SegmentedControl
                label="Match"
                options={MODE_OPTIONS}
                value={mode}
                onChange={onMode}
              />
            ) : null}
          </Cluster>
        ) : null}
        {exclude.length > 0 ? (
          <Cluster gap="xs">
            <Text variant="caption" tone="muted">
              Not tagged
            </Text>
            {exclude.map((t) => (
              <TagChip
                key={t.id}
                tag={t}
                tags={tags}
                excluded
                onRemove={() => onRemove(t.id)}
              />
            ))}
          </Cluster>
        ) : null}
        <Line>
          <Fill>
            <Text variant="caption" tone="faint">
              Click to include · again to exclude
            </Text>
          </Fill>
          <Button variant="link" onClick={onClear}>
            Clear
          </Button>
        </Line>
      </Stack>
    </Surface>
  );
}

function TagTree(props: {
  tags: readonly PlaceTag[];
  counts: ReadonlyMap<string, number>;
  state: SidebarState;
  onCycle: (tagId: string) => void;
}): ReactNode {
  const { tags } = props;
  const [query, setQuery] = useState("");
  // Roots start open, deeper levels closed; `toggled` holds the tags whose
  // open state the user flipped from that default.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  // Each tag's children in tree order (the flattened walk lists siblings in
  // order, so appending as it goes keeps it).
  const childrenOf = useMemo(() => {
    const out = new Map<string | null, PlaceTag[]>();
    for (const { tag } of flattenTagTree(tags)) {
      const siblings = out.get(tag.parentId) ?? [];
      siblings.push(tag);
      out.set(tag.parentId, siblings);
    }
    return out;
  }, [tags]);

  const q = query.trim().toLowerCase();
  // While searching: only tags matching or holding a match, all unfolded.
  const shown = useMemo(() => {
    if (q === "") return null;
    const matches = (t: PlaceTag) => t.name.toLowerCase().includes(q);
    return new Set(
      tags
        .filter((t) => matches(t) || tagDescendants(t.id, tags).some(matches))
        .map((t) => t.id),
    );
  }, [tags, q]);

  const toggle = (id: string) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const branch: TagBranchContext = {
    ...props,
    childrenOf,
    shown,
    isOpen: (id, depth) => shown !== null || (depth === 0) !== toggled.has(id),
    onToggle: toggle,
  };
  const roots = (childrenOf.get(null) ?? []).filter(
    (t) => shown === null || shown.has(t.id),
  );

  return (
    <Stack gap="2xs" className="px-xs pb-sm">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find a tag…"
        aria-label="Find a tag"
      />
      {roots.length === 0 ? (
        <Text variant="caption" tone="faint" className="px-sm">
          No tag matches “{query}”.
        </Text>
      ) : null}
      {roots.map((tag) => (
        <TagBranch key={tag.id} tag={tag} depth={0} ctx={branch} />
      ))}
    </Stack>
  );
}

/** What every branch of the tree reads, handed down unchanged. */
interface TagBranchContext {
  tags: readonly PlaceTag[];
  counts: ReadonlyMap<string, number>;
  state: SidebarState;
  onCycle: (tagId: string) => void;
  childrenOf: ReadonlyMap<string | null, readonly PlaceTag[]>;
  /** The tags a search keeps, or null when not searching. */
  shown: ReadonlySet<string> | null;
  isOpen: (tagId: string, depth: number) => boolean;
  onToggle: (tagId: string) => void;
}

/** A tag's row and, folding under it, its children. */
function TagBranch(props: {
  tag: PlaceTag;
  depth: number;
  ctx: TagBranchContext;
}): ReactNode {
  const { tag, depth, ctx } = props;
  const children = ctx.childrenOf.get(tag.id) ?? [];
  const visible = children.filter(
    (t) => ctx.shown === null || ctx.shown.has(t.id),
  );
  return (
    <CollapsibleProvider
      open={ctx.isOpen(tag.id, depth)}
      onOpenChange={() => ctx.onToggle(tag.id)}
    >
      <TagTreeRow
        tag={tag}
        tags={ctx.tags}
        depth={depth}
        leaf={children.length === 0}
        count={ctx.counts.get(tag.id) ?? 0}
        filterState={tagFilterState(ctx.state, tag.id)}
        partial={hasPickedDescendant(ctx.state, tag.id, ctx.tags)}
        onCycle={() => ctx.onCycle(tag.id)}
      />
      {visible.length > 0 ? (
        <CollapsibleContent>
          <Stack gap="2xs" className="pt-2xs">
            {visible.map((child) => (
              <TagBranch
                key={child.id}
                tag={child}
                depth={depth + 1}
                ctx={ctx}
              />
            ))}
          </Stack>
        </CollapsibleContent>
      ) : null}
    </CollapsibleProvider>
  );
}

function TagTreeRow(props: {
  tag: PlaceTag;
  tags: readonly PlaceTag[];
  depth: number;
  leaf: boolean;
  count: number;
  filterState: TagFilterState;
  partial: boolean;
  onCycle: () => void;
}): ReactNode {
  const { tag, tags, depth, leaf, count, filterState, partial } = props;
  // The branch's fold: this row's disclosure is its trigger.
  const fold = useCollapsibleContext();
  if (!fold) throw new Error("TagTreeRow renders inside its TagBranch's fold");
  return (
    <Line className="gap-2xs" style={{ paddingLeft: depth * INDENT_PX }}>
      {/* The disclosure is its own button beside the row, never inside it:
          the row is itself the include / exclude button. */}
      <button
        type="button"
        aria-label={fold.open ? `Collapse ${tag.name}` : `Expand ${tag.name}`}
        aria-expanded={fold.open}
        aria-controls={leaf ? undefined : fold.contentId}
        onClick={fold.toggle}
        className={cn(
          "size-4 rounded-sm text-muted-foreground hover:bg-hover-fill hover:text-foreground",
          leaf && "invisible",
        )}
      >
        <CollapsibleChevron className="size-3.5" />
      </button>
      <Fill>
        <Row
          size="sm"
          selected={filterState === "include"}
          onClick={props.onCycle}
          title="Click to include, again to exclude"
          className={cn(filterState === "exclude" && "bg-destructive/10")}
          icon={
            <Line className="gap-xs">
              <FilterCheck state={filterState} partial={partial} />
              <TagMark tag={tag} tags={tags} />
            </Line>
          }
        >
          {/* Direct cells of the row's own line: the name takes the slack, so
              the count sits flush right in a faint tabular column. */}
          <>
            <Fill>
              <Text
                tone={
                  filterState === "exclude"
                    ? "destructive"
                    : count === 0
                      ? "faint"
                      : "default"
                }
                className={cn(filterState === "exclude" && "line-through")}
              >
                {tag.name}
              </Text>
            </Fill>
            <Text variant="count" tone="faint" className="min-w-6 text-right">
              {count}
            </Text>
          </>
        </Row>
      </Fill>
    </Line>
  );
}

/** The row's tri-state box: ✓ included, − excluded, a dash outline when a descendant is picked. */
function FilterCheck({
  state,
  partial,
}: {
  state: TagFilterState;
  partial: boolean;
}): ReactNode {
  return (
    <Center
      as="span"
      className={cn(
        "size-3.5 rounded-sm border",
        state === "include" &&
          "border-primary bg-primary text-primary-foreground",
        state === "exclude" &&
          "border-destructive bg-destructive text-primary-foreground",
        state === "off" &&
          (partial ? "border-primary text-primary-text" : "border-border"),
      )}
    >
      {state === "include" ? (
        <Icon icon={checkIcon} className="size-3" />
      ) : state === "exclude" || partial ? (
        <Icon icon={removeIcon} className="size-3" />
      ) : null}
    </Center>
  );
}

/**
 * How many places show, always on screen: the total alone while nothing
 * narrows the view, "3 / 12" (the shown part emphasised) while a filter or
 * search does — so a view narrowed to nothing reads "0 / 12", not an empty
 * map that seems to have lost everything.
 */
function PlaceCount({ shown, total }: { shown: number; total: number }) {
  if (shown === total) {
    return (
      <Text variant="count" tone="muted">
        {total}
      </Text>
    );
  }
  // Two leaves on one tight line (a leaf is its own block in a single-line
  // context, so one nested in another would break the reading in two).
  return (
    <Line
      className={cn("gap-2xs", rigidClass())}
      aria-label={`${shown} of ${total} places shown`}
    >
      <Text variant="count">{shown}</Text>
      <Text variant="count" tone="muted">{`/ ${total}`}</Text>
    </Line>
  );
}
