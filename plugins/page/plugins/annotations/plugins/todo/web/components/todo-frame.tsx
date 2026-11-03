import type { BlockFrameProps } from "@plugins/page/plugins/editor/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import { ContainerBackdrop } from "@plugins/page/plugins/container/web";
import { useTodoTaskState } from "@plugins/page/plugins/annotations/plugins/todo/plugins/task-link/web";

/**
 * The three looks, as whole class strings rather than an interpolated hue: a
 * spliced `` `border-${hue}/40` `` is invisible to Tailwind's scanner, which emits
 * a utility only for literal tokens it can read.
 */
const TINTS = {
  open: "rounded-md bg-warning/10",
  done: "rounded-md bg-success/10",
  dropped: "rounded-md bg-muted/50",
} as const;

/**
 * The TODO card's wash, covering the card's own (zero-height) anchor row
 * AND every block nested inside it.
 *
 * `ContainerBackdrop` owns the geometry, so this file declares nothing but the
 * look, and the frame rules (`BlockFrameProps`) hold by construction: the
 * backdrop fills the box the surface measured — the card's own content box —
 * never `h-full`, and adds no horizontal offset of its own. Semantic theme
 * tokens only, so a preset switch restyles it for free.
 *
 * ## The hue follows the linked task, and stops shouting when it settles
 *
 * A soft wash with no border and no icon, like every card in the family. The hue
 * is the family's "outstanding work" `warning` until the card's
 * task says otherwise: `done` repaints it `success`, `dropped` fades it to
 * `muted`. Every other status (including no task at all) is still outstanding
 * work and still warning. So a finished TODO stops competing for attention
 * without disappearing from the page.
 *
 * The status lives beside the row, not in it — a side table keyed by block id
 * joined to the task — which is what `BlockFrameProps.blockId` exists for. A
 * node carrying no id (a forest with no rows behind it) has nothing to look up
 * and paints the static `warning` box.
 *
 * A read-only surface that DOES carry ids (the version-history preview) tints
 * from the card's task as it stands NOW, not as it stood in the snapshot. That
 * is deliberate and not the same lie the prompt block's launch chips would be:
 * the box says what remains to be done about this card, which is a fact about
 * the card today whichever revision of its text you are reading.
 */
export function TodoFrame(props: BlockFrameProps) {
  if (props.blockId === undefined)
    return <ContainerBackdrop frame={props} className={TINTS.open} />;
  return <LinkedTodoFrame blockId={props.blockId} frame={props} />;
}

/**
 * The editable-surface arm, split out so the link subscription is a hook on a
 * component that only ever mounts when there is a block id to key it by.
 */
function LinkedTodoFrame({
  blockId,
  frame,
}: {
  blockId: string;
  frame: BlockFrameProps;
}) {
  const dispatched = useTodoTaskState(blockId);
  // A wash has no room for a loading or error affordance, so both paint the
  // "outstanding work" hue — the card's own look before any task says
  // otherwise. The dispatch panel behind the card's glyph is where a failed
  // read is reported, with Retry.
  const tint = foldResource(dispatched, {
    loading: () => TINTS.open,
    error: () => TINTS.open,
    ready: (task) =>
      task?.status === "done"
        ? TINTS.done
        : task?.status === "dropped"
          ? TINTS.dropped
          : TINTS.open,
  });

  return <ContainerBackdrop frame={frame} className={tint} />;
}
