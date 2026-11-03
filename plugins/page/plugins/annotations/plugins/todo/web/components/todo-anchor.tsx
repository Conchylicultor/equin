import { ContainerCornerLabel } from "@plugins/page/plugins/container/web";
import type {
  BlockAnchorProps,
  BlockEditorAPI,
} from "@plugins/page/plugins/editor/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  TodoDispatch,
  useTodoTask,
} from "@plugins/page/plugins/annotations/plugins/todo/plugins/task-link/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const playArrowIcon = symbol("play-arrow");
const errorIcon = symbol("error");

/**
 * The TODO card's name, in the top-right corner of its box — and the way an
 * agent is dispatched onto it.
 *
 * ## The name IS the launch control
 *
 * Most TODO cards never launch anything, so a launch button that is always on
 * screen is a permanent price for a rare act. This adds nothing at rest: point
 * at the card and it says `TODO`; move onto that word and it becomes
 * `▷ LAUNCH`, in place, at the same size. The answer to *what is this box* turns
 * into the affordance, so the card gains no control at all — the one it already
 * had changes what it says.
 *
 * The panel behind it is unchanged and unmoved: the same `TodoDispatch` that the
 * rail's block-actions menu opens (`BlockFrameMeta.menu`), which is the
 * container convention — the rail is where a user looks for block actions, the
 * decoration is where they look for the decoration.
 *
 * ## The name is the card's NAME again, dispatched or not
 *
 * It used to make one exception: a dispatched card stopped hiding its name and
 * spelled the task's live status there instead (`RUNNING`, `DONE`), because the
 * tint cannot say it — an open card and a card with an agent working on it are
 * both `warning` — and nothing else on the card could.
 *
 * Something else can now. The card's FOOT carries a chip per run
 * (`BlockFrameMeta.foot` → `TodoFoot`), which says the same thing on something
 * you can click to go and look. So the exception is gone: the name is worth
 * nothing at rest whatever the task is doing, and a card that spelled the status
 * in two places would be a card whose two answers can drift apart the day a
 * status is added.
 *
 * The link is still read here for one thing only — whether launching again is
 * *again* — which is a fact about this control's own wording, not a second
 * rendering of the task's state.
 *
 * ## Three states, and the two degradations are the same one
 *
 * `blockId` and `editor` are both optional on `BlockAnchorProps` and both absent
 * on a read-only surface (the blog renderer, the version-history preview): a
 * read-only node may carry no id, and there is no block API to hand a popover.
 * Either one missing ⇒ the static name, unchanged from before. Dispatching is
 * live agent state, so a snapshot of last Tuesday must not offer it — and the
 * panel would crash rather than degrade there anyway (`useOpenPane` /
 * `conversationPane.useRouteEntries()` do not exist on the public-site surface).
 */
export function TodoAnchor({ blockId, editor }: BlockAnchorProps) {
  if (!editor || blockId === undefined)
    return (
      <ContainerCornerLabel
        blockId={blockId}
        name="Todo"
        className="text-warning/80"
      />
    );
  return <DispatchableTodoAnchor blockId={blockId} editor={editor} />;
}

/**
 * The editable-surface arm, split out so the link subscription is a hook on a
 * component that only ever mounts when there is a block id to key it by.
 */
function DispatchableTodoAnchor({
  blockId,
  editor,
}: {
  blockId: string;
  editor: BlockEditorAPI;
}) {
  const link = useTodoTask(blockId);

  // Until the link is known, the name only: offering "Launch" on a card that
  // was already dispatched would misstate it, so the action waits.
  if (link.status === "loading") {
    return (
      <ContainerCornerLabel
        blockId={blockId}
        editor={editor}
        name="Todo"
        className="text-warning/80"
      />
    );
  }
  // A failed read still cannot offer "Launch" (it may misstate the card), so
  // the trigger opens the failure with its retry instead — unless the link was
  // seen before the failure, which only ever holds a dispatched card.
  if (link.status === "error" && link.stale === undefined) {
    return (
      <ContainerCornerLabel
        blockId={blockId}
        editor={editor}
        name="Todo"
        className="text-warning/80"
        action={<Icon icon={errorIcon} className="size-3 text-destructive" />}
        triggerLabel="Couldn't load this card's dispatch"
        width="md"
        sections={() => (
          <ResourceErrorInline
            error={link.error}
            refetch={link.refetch}
            variant="block"
            subject="this card's dispatch"
          />
        )}
      />
    );
  }
  const dispatched = link.status === "error" || link.found;

  return (
    <ContainerCornerLabel
      blockId={blockId}
      editor={editor}
      name="Todo"
      className="text-warning/80"
      action={
        <Row gap="2xs" align="center">
          <Icon icon={playArrowIcon} className="size-3" />
          {dispatched ? "Launch again" : "Launch"}
        </Row>
      }
      triggerLabel={dispatched ? "TODO card's agent run" : "Dispatch an agent"}
      width="2xl"
      sections={({ close }) => <TodoDispatch blockId={blockId} close={close} />}
    />
  );
}
