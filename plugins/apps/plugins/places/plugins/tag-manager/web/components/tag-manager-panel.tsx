import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  DataView,
  defineDataView,
  fieldOverrides,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { confirmDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/plugins/confirm/web";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  placeTags,
  placeTagTree,
  tagPlaceCounts,
  type Place,
  type PlaceTag,
} from "@plugins/apps/plugins/places/plugins/places-core/core";
import {
  freeSiblingName,
  type UpdateTagBody,
} from "@plugins/tag-tree/plugins/engine/core";
import { useTagTreeActions } from "@plugins/tag-tree/plugins/engine/web";
import { TagColorButton } from "./tag-color-button";
import { TagIconButton } from "./tag-icon-button";
import { TagNameInput } from "./tag-name-input";
import { TagParentSelect } from "./tag-parent-select";

/**
 * The tag manager's surface id. Config-backed like every DataView: its one
 * table view lives in `config/apps/places/tag-manager/places.tags.jsonc`.
 */
const TAGS_VIEW = defineDataView("places.tags");

/** Open on first paint: the manager shows the whole tree. */
const TAG_TABLE_OPTIONS = { defaultExpanded: true, addLabel: null };

export interface TagManagerPanelProps {
  /** Every saved place — what the Places column counts. */
  places: readonly Place[];
  /** The whole tag tree. */
  tags: readonly PlaceTag[];
  /**
   * A tag whose name field takes focus when its row mounts — a tag just made
   * by "+ New tag", so the user types its name straight away.
   */
  focusTagId?: string | null;
  onClose: () => void;
}

/**
 * Manage tags: the one tag tree as an editable table, as a floating card. A
 * row per tag, nested under its parent: colour (own or inherited),
 * icon, name (edited in place), parent (never itself or a descendant), the
 * Google types that set it automatically, how many places carry it (nested
 * tags included), and Shade children (a parent's colourless children as a
 * light → deep ramp of its colour) / + Child / Delete. Every edit goes straight to the tag-tree
 * engine's endpoints (`useTagTreeActions(placeTagTree)`); the live tag
 * collection brings it back to every surface.
 *
 * The rows are a DataView (the table view) nesting the tag collection by
 * `parentId` — sorting is off on every column, since the tree order IS the
 * meaning.
 */
export function TagManagerPanel({
  places,
  tags,
  focusTagId = null,
  onClose,
}: TagManagerPanelProps) {
  const [focus, setFocus] = useState<string | null>(focusTagId);
  const { create: createTag } = useTagTreeActions(placeTagTree);
  const counts = useMemo(() => tagPlaceCounts(places, tags), [places, tags]);
  // A tag's parent is its `parentId`, its place among its siblings its stored
  // fractional rank.
  const hierarchy = useMemo(
    () => ({
      getParentId: (t: PlaceTag) => t.parentId,
      getRank: (t: PlaceTag) => Rank.from(t.rank),
    }),
    [],
  );

  // A sibling name must be free: "New tag", else "New tag 2", …
  const addTag = useCallback(
    async (parentId: string | null) => {
      const tag = await createTag({
        name: freeSiblingName("New tag", parentId, tags),
        parentId,
      });
      setFocus(tag.id);
    },
    [createTag, tags],
  );

  // The tag and the Google types are the collection's, derived; what the
  // manager changes of them is their cell (and the tag's label).
  const overrides = useMemo(
    () =>
      fieldOverrides(placeTags, {
        name: {
          label: "Tag",
          cell: (t) => (
            <TagNameCell tag={t} tags={tags} autoFocus={t.id === focus} />
          ),
          width: "18rem",
        },
        googleTypes: { cell: (t) => <GoogleTypes types={t.googleTypes} /> },
      }),
    [tags, focus],
  );

  // The columns the manager computes: the parent (an editable pick of the
  // tree), the place count and the row actions.
  const extraFields = useMemo<FieldDef<PlaceTag>[]>(
    () => [
      {
        id: "parent",
        label: "Parent",
        type: "text",
        value: (t) =>
          tags.find((p) => p.id === t.parentId)?.name ?? "Top level",
        cell: (t) => <TagParentSelect tag={t} tags={tags} />,
        width: "11rem",
      },
      {
        id: "places",
        label: "Places",
        type: "number",
        value: (t) => counts.get(t.id) ?? 0,
        width: "5rem",
      },
      {
        id: "actions",
        label: "Actions",
        header: false,
        cell: (t) => (
          <TagRowActions
            tag={t}
            hasChildren={tags.some((c) => c.parentId === t.id)}
            onAddChild={() => addTag(t.id)}
          />
        ),
        width: "16rem",
      },
    ],
    [tags, counts, addTag],
  );

  return (
    <Surface level="overlay" className="h-full">
      <Column
        className="h-full"
        header={
          <Line className="gap-md border-b p-md">
            <Fill>
              <Stack gap="2xs">
                <Text variant="heading">Manage tags</Text>
                <Text variant="caption" tone="muted">
                  One tree for everything — Been, Want to go, categories, price.
                  A tag without its own colour uses its parent&apos;s. Tags with
                  Google types are set automatically on a new place.
                </Text>
              </Stack>
            </Fill>
            <Button variant="outline" onClick={() => addTag(null)}>
              New tag
            </Button>
            <Button variant="outline" onClick={onClose}>
              Done
            </Button>
          </Line>
        }
        body={
          <DataView<PlaceTag>
            storageKey={TAGS_VIEW}
            rows={tags}
            collection={placeTags}
            overrides={overrides}
            extraFields={extraFields}
            hierarchy={hierarchy}
            viewOptions={{ table: TAG_TABLE_OPTIONS }}
            rowKey={(t) => t.id}
            views={["table"]}
            density="compact"
            searchPlaceholder="Find a tag…"
          />
        }
      />
    </Surface>
  );
}

function TagNameCell({
  tag,
  tags,
  autoFocus,
}: {
  tag: PlaceTag;
  tags: readonly PlaceTag[];
  autoFocus: boolean;
}): ReactNode {
  const { update: updateTag } = useTagTreeActions(placeTagTree);
  const update = (body: UpdateTagBody) => updateTag(tag.id, body);
  return (
    <Line className="gap-xs">
      <TagColorButton
        tag={tag}
        tags={tags}
        onChange={(color) => update({ color })}
      />
      <TagIconButton
        tag={tag}
        tags={tags}
        onChange={(icon) => update({ icon })}
      />
      <Fill>
        <TagNameInput
          name={tag.name}
          autoFocus={autoFocus}
          onCommit={(name) => update({ name })}
        />
      </Fill>
    </Line>
  );
}

function GoogleTypes({ types }: { types: readonly string[] }): ReactNode {
  if (types.length === 0) {
    return (
      <Text variant="caption" tone="faint">
        manual
      </Text>
    );
  }
  return (
    <Cluster gap="2xs">
      {types.map((type) => (
        <Badge key={type} variant="warning" mono>
          {type}
        </Badge>
      ))}
    </Cluster>
  );
}

function TagRowActions({
  tag,
  hasChildren,
  onAddChild,
}: {
  tag: PlaceTag;
  /** Shade children is offered on a parent only. */
  hasChildren: boolean;
  onAddChild: () => Promise<void>;
}): ReactNode {
  const { update: updateTag, remove: deleteTag } =
    useTagTreeActions(placeTagTree);
  // A tag with a role (Been, Want to go) is how the app finds them: the tree
  // refuses to delete it (`refuseDelete`), so the action is not offered.
  const deletable = tag.role === null;
  const ramp = tag.childColors === "ramp";
  return (
    <Line className="gap-2xs">
      <Fill />
      {hasChildren && (
        <ToggleChip
          variant="tinted"
          active={ramp}
          tooltip="Colour the children without their own colour as shades of this one, light to deep in their order"
          onClick={() =>
            void updateTag(tag.id, { childColors: ramp ? null : "ramp" })
          }
        >
          Shade children
        </ToggleChip>
      )}
      <Button variant="ghost" onClick={onAddChild}>
        + Child
      </Button>
      {deletable && (
        <Button
          variant="ghost"
          onClick={() =>
            void confirmDialog({
              title: `Delete “${tag.name}”?`,
              description:
                "Its child tags move up to its parent, and every place carrying it gets the parent instead.",
              confirmLabel: "Delete tag",
              onConfirm: () => deleteTag(tag.id),
            })
          }
        >
          Delete
        </Button>
      )}
    </Line>
  );
}
