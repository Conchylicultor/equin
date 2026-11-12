import { useMemo, type ReactNode } from "react";
import {
  DataViewViewChip,
  DataViewViewList,
  useDataViewControls,
  useFlatRows,
  useRowFilter,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import {
  Rigid,
  rigidClass,
} from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleProvider,
  CollapsibleTrigger,
} from "@plugins/primitives/plugins/collapsible/web";
import {
  placeTagTree,
  tagPlaceCounts,
  type Place,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import { TagPickerPanel } from "@plugins/tag-tree/plugins/picker/web";
import { KeepAnchorAcross } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { useTagTreeActions } from "@plugins/tag-tree/plugins/engine/web";
import {
  applySidebarState,
  toggleTag,
  includedTags,
  presetAutoName,
  presetIcon,
  sidebarState,
  withoutSidebarRules,
  type SidebarState,
} from "../../core";
import { AppShellBrand } from "@plugins/primitives/plugins/app-shell/web";
import { placeSearchText } from "../internal/fields";
import { TagFilterBox } from "./tag-filter-box";

export interface TagSidebarProps {
  /** Every saved place (the faceted counts run over them). */
  places: readonly Place[];
  /** The whole tag tree. */
  tags: readonly PlaceTag[];
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
 * search-or-create and the tree, each row's count being how many places the REST of the
 * filter keeps that carry the tag or a tag nested under it. A click includes a
 * tag — it joins the row of its root tag (or), else starts one (and) — or drops
 * a picked one (an exclusion is written in the advanced filter; the box shows
 * it and a click drops it). The tree is the shared tag picker
 * (`TagPickerPanel`), so it is also where tags are made and edited.
 */
export function TagSidebar({
  places,
  tags,
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
  const writes = useTagTreeActions(placeTagTree);
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
        // The column owns the inset: the header, the presets and the whole tag
        // picker below land on one `sm` rail, none of them padding itself.
        inset="sm"
        className="w-72"
        header={
          <Stack gap="sm">
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
            {/* The header grows and shrinks with the filter (the tag box gains a
                row on a pick, loses it on a ×, goes on Clear): keep the row the
                reader is on — the one just clicked — where it is on screen, by
                scrolling the tree by however far the header moved it. */}
            <KeepAnchorAcross
              changeKey={filter}
              anchorAttr="data-tree-id"
              browserAnchoring
            >
              {/* The shared tag tree, both the filter and the editor: a click
                includes or drops a tag, ＋ / ⋯ / double-click / drag edit the
                tree, and the search finds a tag or creates the typed path
                (left unpicked: a new tag carries no place yet). */}
              <TagPickerPanel
                tags={tags}
                writes={writes}
                indicator="checkbox"
                selected={includedTags(state)}
                negated={state.exclude}
                counts={counts ?? undefined}
                defaultExpanded="roots"
                autoFocus={false}
                pickCreated={false}
                // Been / Want to go are how the app finds them (the tree's
                // `refuseDelete` refuses it too).
                canDelete={(t) => t.role === null}
                rowMenuExtra={(t) => <GoogleTypes types={t.googleTypes} />}
                onPick={(id) => {
                  if (id !== null) write(toggleTag(state, id, tags));
                }}
              />
            </KeepAnchorAcross>
          </CollapsibleContent>
        }
      />
    </CollapsibleProvider>
  );
}

/** The Google types a tag is auto-set from, read-only at the foot of its ⋯ menu. */
function GoogleTypes({ types }: { types: readonly string[] }): ReactNode {
  return (
    <Stack gap="2xs" className="px-sm py-xs">
      <Text variant="caption" tone="muted">
        Auto-set from Google types
      </Text>
      {types.length === 0 ? (
        <Text variant="caption" tone="faint">
          manual
        </Text>
      ) : (
        <Cluster gap="2xs">
          {types.map((type) => (
            <Badge key={type} variant="warning" mono>
              {type}
            </Badge>
          ))}
        </Cluster>
      )}
    </Stack>
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
