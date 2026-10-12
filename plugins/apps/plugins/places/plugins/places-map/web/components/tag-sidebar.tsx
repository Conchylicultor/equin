import { useMemo, useState, type ReactNode } from "react";
import {
  useDataViewControls,
  useRowFilter,
} from "@plugins/primitives/plugins/data-view/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
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
import { BrandMark } from "./brand-mark";
import { TagChip } from "./tag-chip";

const chevronIcon = symbol("chevron-right");
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
 * Header: "Places" and the total; the "Tagged / Not tagged" summary with the
 * any / all switch and Clear (once anything is picked); a tag search. Body:
 * the tree, each row's count being how many places the REST of the filter
 * keeps that carry the tag or a tag nested under it. A click cycles
 * include → exclude → off. Footer: + New tag, Manage tags.
 */
export function TagSidebar({
  places,
  tags,
  onNewTag,
  onManageTags,
}: TagSidebarProps) {
  const { filter: controller, fields } = useDataViewControls();
  const { filter, setFilter, resolveOperatorSet } = controller;
  const state = useMemo(() => sidebarState(filter), [filter]);
  const write = (next: SidebarState) =>
    setFilter(applySidebarState(filter, next));

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

  return (
    <Column
      className="h-full w-72"
      header={
        <Stack gap="sm" className="p-sm">
          <Line className="gap-sm px-xs pt-xs">
            <BrandMark />
            <Fill>
              <Text variant="heading">Places</Text>
            </Fill>
            <Text variant="count" tone="muted">
              {places.length}
            </Text>
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
        <TagTree
          tags={tags}
          counts={counts}
          state={state}
          onCycle={(id) => write(cycleTag(state, id, tags))}
        />
      }
      footer={
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
      }
    />
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
  const { tags, counts, state, onCycle } = props;
  const [query, setQuery] = useState("");
  // Roots start open, deeper levels closed; `toggled` holds the tags whose
  // open state the user flipped from that default.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const entries = useMemo(() => flattenTagTree(tags), [tags]);
  const hasChildren = useMemo(
    () =>
      new Set(tags.flatMap((t) => (t.parentId === null ? [] : [t.parentId]))),
    [tags],
  );

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const matches = (t: PlaceTag) => t.name.toLowerCase().includes(q);
    const isOpen = (id: string, depth: number) =>
      q !== "" || (depth === 0) !== toggled.has(id);
    const out: { tag: PlaceTag; depth: number; open: boolean }[] = [];
    // A closed tag hides everything deeper than it until the walk climbs back.
    let hideBelow = Number.POSITIVE_INFINITY;
    for (const { tag, depth } of entries) {
      if (depth > hideBelow) continue;
      hideBelow = Number.POSITIVE_INFINITY;
      if (
        q !== "" &&
        !matches(tag) &&
        !tagDescendants(tag.id, tags).some(matches)
      ) {
        hideBelow = depth;
        continue;
      }
      const open = isOpen(tag.id, depth);
      out.push({ tag, depth, open });
      if (!open) hideBelow = depth;
    }
    return out;
  }, [entries, tags, q, toggled]);

  const toggle = (id: string) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Stack gap="2xs" className="px-xs pb-sm">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find a tag…"
        aria-label="Find a tag"
      />
      {visible.length === 0 ? (
        <Text variant="caption" tone="faint" className="px-sm">
          No tag matches “{query}”.
        </Text>
      ) : null}
      {visible.map(({ tag, depth, open }) => (
        <TagTreeRow
          key={tag.id}
          tag={tag}
          tags={tags}
          depth={depth}
          open={open}
          leaf={!hasChildren.has(tag.id)}
          count={counts.get(tag.id) ?? 0}
          filterState={tagFilterState(state, tag.id)}
          partial={hasPickedDescendant(state, tag.id, tags)}
          onToggle={() => toggle(tag.id)}
          onCycle={() => onCycle(tag.id)}
        />
      ))}
    </Stack>
  );
}

function TagTreeRow(props: {
  tag: PlaceTag;
  tags: readonly PlaceTag[];
  depth: number;
  open: boolean;
  leaf: boolean;
  count: number;
  filterState: TagFilterState;
  partial: boolean;
  onToggle: () => void;
  onCycle: () => void;
}): ReactNode {
  const { tag, tags, depth, open, leaf, count, filterState, partial } = props;
  return (
    <Line className="gap-2xs" style={{ paddingLeft: depth * INDENT_PX }}>
      {/* The disclosure is its own button beside the row, never inside it:
          the row is itself the include / exclude button. */}
      <button
        type="button"
        aria-label={open ? `Collapse ${tag.name}` : `Expand ${tag.name}`}
        aria-expanded={open}
        onClick={props.onToggle}
        className={cn(
          "size-4 rounded-sm text-muted-foreground hover:bg-hover-fill hover:text-foreground",
          leaf && "invisible",
        )}
      >
        <Icon
          icon={chevronIcon}
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
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
