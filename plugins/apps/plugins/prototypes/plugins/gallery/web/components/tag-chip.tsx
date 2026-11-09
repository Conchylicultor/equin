import { useMemo } from "react";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { rolledUpTagCounts } from "@plugins/tag-tree/plugins/engine/core";
import { useTagTree } from "@plugins/tag-tree/plugins/engine/web";
import {
  TagPathChip,
  TagPickerPopover,
} from "@plugins/tag-tree/plugins/picker/web";
import { prototypesList } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { prototypeTagTree } from "@plugins/apps/plugins/prototypes/plugins/state/core";
import {
  usePrototypeState,
  usePrototypeStates,
  useSetPrototypeState,
} from "@plugins/apps/plugins/prototypes/plugins/state/web";
import { usePrototypeDetail } from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { PrototypeGalleryRow } from "../slots";

const labelIcon = symbol("label");

/**
 * The detail pane header's tag chip, right after the title: the prototype's
 * one tag as a path (`TagPathChip`, dashed `＋ Tag` when untagged), opening the
 * shared tag picker — pick, create a typed path, rename, recolour, nest,
 * reorder, delete. Pending until the prototype's state is known, rather than
 * claiming "untagged".
 */
export function TagHeaderAction() {
  const { name } = usePrototypeDetail();
  const read = usePrototypeState(name);
  const { setState } = useSetPrototypeState();
  const counts = useTagCounts();
  if (read.status === "loading") {
    return <Loading variant="text" label="Tag" />;
  }
  if (read.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        icon={labelIcon}
        subject="the prototype's tag"
        error={read.error}
        refetch={read.refetch}
      />
    );
  }
  const { tagId } = read.data;
  return (
    <TagPickerPopover
      tree={prototypeTagTree}
      selected={tagId === null ? [] : [tagId]}
      offerNone
      counts={counts}
      onPick={(id) => setState(name, { tagId: id })}
      trigger={<TagPathChip tree={prototypeTagTree} tagId={tagId} />}
    />
  );
}

/**
 * The card's Edit tag (a revealed item action): the label glyph opening the
 * same tag picker as the detail header's chip, on the card's own tag. The row
 * already carries `tagId` — the gallery joins the states onto the list before
 * it renders. The click never opens the card (its `RowActions` cluster stops
 * it, the picker's portaled clicks included).
 */
export function TagCardAction({ row }: ItemActionProps<PrototypeGalleryRow>) {
  const { pending, setState } = useSetPrototypeState();
  const counts = useTagCounts();
  return (
    <ControlSizeProvider size="sm">
      <TagPickerPopover
        tree={prototypeTagTree}
        selected={row.tagId === null ? [] : [row.tagId]}
        offerNone
        counts={counts}
        onPick={(id) => setState(row.name, { tagId: id })}
        trigger={
          <IconButton
            icon={labelIcon}
            label="Edit tag"
            variant="ghost"
            loading={pending}
          />
        }
      />
    </ControlSizeProvider>
  );
}

/**
 * How many listed prototypes carry each tag or anything under it — the
 * picker's count column. Absent (no column) until the list, the states and
 * the tree are all known.
 */
function useTagCounts(): ReadonlyMap<string, number> | undefined {
  const list = useLive(prototypesList);
  const states = usePrototypeStates();
  const tags = useTagTree(prototypeTagTree);
  return useMemo(() => {
    if (
      list.status === "ready" &&
      states.status === "ready" &&
      tags.status === "ready"
    ) {
      const tagOf = new Map<string, string | null>(
        states.data.map((s) => [s.id, s.tagId]),
      );
      const carried = list.data.flatMap((p) => {
        const tagId = tagOf.get(p.name) ?? null;
        return tagId === null ? [] : [[tagId]];
      });
      return rolledUpTagCounts(carried, tags.data);
    }
    return undefined;
  }, [list, states, tags]);
}
