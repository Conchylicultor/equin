import { useMemo, useState, type ReactNode } from "react";
import {
  DataViewViewChip,
  DataViewViewList,
  useDataViewControls,
  useFlatRows,
  useRowFilter,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  Rigid,
  rigidClass,
} from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  Input,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleProvider,
  CollapsibleTrigger,
  useCollapsibleContext,
} from "@plugins/primitives/plugins/collapsible/web";
import {
  tagPlaceCounts,
  type Place,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  flattenTagTree,
  tagDescendants,
} from "@plugins/tag-tree/plugins/engine/core";
import { TagMark } from "@plugins/tag-tree/plugins/picker/web";
import {
  applySidebarState,
  toggleTag,
  hasPickedDescendant,
  presetAutoName,
  presetIcon,
  sidebarState,
  tagFilterState,
  withoutSidebarRules,
  type SidebarState,
  type TagFilterState,
} from "../internal/sidebar-filter";
import { AppShellBrand } from "@plugins/primitives/plugins/app-shell/web";
import { placeSearchText } from "../internal/fields";
import { TagFilterBox } from "./tag-filter-box";

const checkIcon = symbol("check");
const removeIcon = symbol("remove");
const addIcon = symbol("add");
const tuneIcon = symbol("tune");

/** One tree level's indent, in px. */
const INDENT_PX = 14;

export interface TagSidebarProps {
  /** Every saved place (the faceted counts run over them). */
  places: readonly Place[];
  /** The whole tag tree. */
  tags: readonly PlaceTag[];
  /** "+ New tag": make one and open the tag manager on it. */
  onNewTag: () => Promise<void>;
  /** "Manage tags": open the tag manager. */
  onManageTags: () => void;
  /** Unfolded: the presets, the tag filter, the tree. Folded: the header alone,
   *  the active preset's name (a dropdown of every preset) as its title. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The Places surface's `aside`: the presets, the tag tree, and the tag half
 * of the active preset's filter. It reads and writes the active view's filter
 * through `useDataViewControls()` — the filter is the one source of truth, and
 * the sidebar owns only its top-level nested-tags rules (`sidebar-filter.ts`).
 * The surface drafts its view edits (`viewEdits`), so every tag picked here
 * edits the preset's working copy until it is saved.
 *
 * Header: the app launcher (the app's mark), "Places" and how many places
 * show, the fold chevron — folded, the card keeps its width and this header
 * alone, its title the active preset (`DataViewViewChip appearance="title"`:
 * every preset as a draggable list); unfolded, the presets (`DataViewViewList`: icon, name,
 * count, dirty dot, ⋯, drag, "+ New preset" — a preset from the current
 * filter, named after its tags, opened for renaming); then the tag filter box
 * (`TagFilterBox`: AND-ed rows of OR-ed tags, the excluded ones) with the
 * preset's actions while it has unsaved edits — on the home preset Clear and
 * Save as preset, on another Reset, Save as new and Update. Body: a tag
 * search and the tree, each row's count being how many places the REST of the
 * filter keeps that carry the tag or a tag nested under it. A click includes a
 * tag — it joins the row of its root tag (or), else starts one (and) — or drops
 * a picked one (an exclusion is written in the advanced filter; the box shows
 * it and a click drops it). Footer: + New tag, Manage tags.
 */
export function TagSidebar({
  places,
  tags,
  onNewTag,
  onManageTags,
  open,
  onOpenChange,
}: TagSidebarProps) {
  const {
    filter: controller,
    fields,
    activeState,
    activeViewId,
    viewModel,
  } = useDataViewControls();
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

  // Faceted counts: the rows the rest of the view filter keeps — none while
  // that filter names a rule that does not resolve (the view shows the rule
  // error, and counts over every place would claim rows it cannot vouch for).
  const rest = useMemo(() => withoutSidebarRules(filter), [filter]);
  const keep = useRowFilter(rest, fields, resolveOperatorSet);
  const counts = useMemo(
    () =>
      keep.kind === "unavailable"
        ? null
        : tagPlaceCounts(
            keep.kind === "match" ? places.filter(keep.matches) : places,
            tags,
          ),
    [keep, places, tags],
  );

  const { drafts, dirtyFor, homeViewId, setRenamingId } = viewModel;
  if (drafts === null) {
    throw new Error(
      "TagSidebar: the Places surface drafts its view edits (viewEdits), so its presets have working copies",
    );
  }
  const dirty = dirtyFor(activeViewId);
  // A preset from the filter as it stands: named after its tags, with its
  // first tag's icon, active, and its name open for editing. The preset it
  // was made from goes back to its saved filter.
  const saveAsPreset = () => {
    const icon = presetIcon(state, tags);
    const id = drafts.saveAsNew(activeViewId, {
      name: presetAutoName(state, tags),
      ...(icon === null ? {} : { icon }),
    });
    setRenamingId(id);
  };
  const actions = !dirty ? undefined : activeViewId === homeViewId ? (
    <>
      <Button variant="ghost" onClick={() => drafts.discard(activeViewId)}>
        Clear
      </Button>
      <Fill />
      <Button onClick={saveAsPreset}>Save as preset</Button>
    </>
  ) : (
    <>
      <Button
        variant="ghost"
        tooltip="Back to the saved filter — leaving the preset does the same"
        onClick={() => drafts.discard(activeViewId)}
      >
        Reset
      </Button>
      <Fill />
      <Button variant="ghost" onClick={saveAsPreset}>
        Save as new
      </Button>
      <Button
        tooltip="Overwrite the preset with this filter"
        onClick={() => drafts.save(activeViewId)}
      >
        Update
      </Button>
    </>
  );

  const count = <PlaceCount shown={shown} total={places.length} />;
  const chevron = (
    <CollapsibleChevron className="size-4 text-muted-foreground" />
  );
  return (
    // One fold for everything under the header: the presets, the tag box, the
    // tree and the footer slide away together; the header (and the card's
    // width) stays, naming the active preset.
    <CollapsibleProvider open={open} onOpenChange={onOpenChange}>
      {/* `fill`: the floating aside card hugs this column's height up to the
          surface's, so the tree scrolls between a header and footer that stay put. */}
      <Column
        fill
        className="w-72"
        header={
          <Stack gap="sm" className="p-sm">
            {/* The launcher is a button of its own, so it sits beside the
                fold trigger rather than inside it — and folded, so does the
                preset dropdown that takes the title's place. */}
            <Line className="gap-2xs">
              <AppShellBrand form="icon" />
              {open ? (
                <Fill>
                  <CollapsibleTrigger
                    aria-label="Collapse sidebar"
                    className="gap-sm rounded-md p-xs hover:bg-hover-fill"
                  >
                    <Fill>
                      <Text variant="heading">Places</Text>
                    </Fill>
                    {count}
                    {chevron}
                  </CollapsibleTrigger>
                </Fill>
              ) : (
                <>
                  <Fill>
                    <DataViewViewChip appearance="title" />
                  </Fill>
                  {/* Rigid: the trigger is full-width by default; here it
                      sizes to its count and chevron beside the title. */}
                  <Rigid>
                    <CollapsibleTrigger
                      aria-label="Expand sidebar"
                      className="gap-sm rounded-md p-xs hover:bg-hover-fill"
                    >
                      {count}
                      {chevron}
                    </CollapsibleTrigger>
                  </Rigid>
                </>
              )}
            </Line>
            <CollapsibleContent>
              <Stack gap="sm">
                <DataViewViewList newLabel="New preset" onNew={saveAsPreset} />
                {state.rows.length + state.exclude.length > 0 || dirty ? (
                  <TagFilterBox
                    state={state}
                    tags={tags}
                    onChange={write}
                    footer={actions}
                  />
                ) : null}
              </Stack>
            </CollapsibleContent>
          </Stack>
        }
        body={
          <CollapsibleContent>
            <TagTree
              tags={tags}
              counts={counts}
              state={state}
              onPick={(id) => write(toggleTag(state, id, tags))}
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

function TagTree(props: {
  tags: readonly PlaceTag[];
  /** Null while the rest of the view filter cannot run: no counts drawn. */
  counts: ReadonlyMap<string, number> | null;
  state: SidebarState;
  onPick: (tagId: string) => void;
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
  counts: ReadonlyMap<string, number> | null;
  state: SidebarState;
  onPick: (tagId: string) => void;
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
        count={ctx.counts === null ? null : (ctx.counts.get(tag.id) ?? 0)}
        filterState={tagFilterState(ctx.state, tag.id)}
        partial={hasPickedDescendant(ctx.state, tag.id, ctx.tags)}
        onPick={() => ctx.onPick(tag.id)}
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
  count: number | null;
  filterState: TagFilterState;
  partial: boolean;
  onPick: () => void;
}): ReactNode {
  const { tag, tags, depth, leaf, count, filterState, partial } = props;
  // The branch's fold: this row's disclosure is its trigger.
  const fold = useCollapsibleContext();
  if (!fold) throw new Error("TagTreeRow renders inside its TagBranch's fold");
  return (
    <Line className="gap-2xs" style={{ paddingLeft: depth * INDENT_PX }}>
      {/* The disclosure is its own button beside the row, never inside it:
          the row is itself the include button. */}
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
          // The tree row's identity on the DOM (e2e scripts find rows by it).
          data-tag-row={tag.id}
          size="sm"
          selected={filterState === "include"}
          onClick={props.onPick}
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
            {count === null ? null : (
              <Text variant="count" tone="faint" className="min-w-6 text-right">
                {count}
              </Text>
            )}
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
