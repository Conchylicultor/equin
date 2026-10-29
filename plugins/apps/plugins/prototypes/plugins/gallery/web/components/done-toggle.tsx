import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  TitleActionButton,
  usePrototypeDetail,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import type { PrototypeGalleryRow } from "../slots";
import {
  usePrototypeState,
  useSetPrototypeState,
} from "@plugins/apps/plugins/prototypes/plugins/state/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const checkCircleIcon = symbol("check-circle");
const radioButtonUncheckedIcon = symbol("radio-button-unchecked");

// Marking a prototype Done — one field of its state row
// (`apps/prototypes/state`, the instance's DB).

/**
 * The card action's rest state: on while the prototype is done, so the
 * action stays painted at rest then and shows only on hover otherwise. A plain
 * read of the joined row — no subscription of its own.
 */
export function useDoneActive(row: PrototypeGalleryRow): boolean {
  return row.done;
}

/**
 * The card's Done circle (a revealed item action that rests while done, so a
 * finished prototype reads as one at rest). The row already carries `done` —
 * the gallery joins the states onto the list before it renders.
 */
export function DoneCardAction({ row }: ItemActionProps<PrototypeGalleryRow>) {
  const { setState } = useSetPrototypeState();
  return (
    <ControlSizeProvider size="sm">
      <IconButton
        icon={row.done ? checkCircleIcon : radioButtonUncheckedIcon}
        label={row.done ? "Done — mark as not done" : "Mark as done"}
        aria-pressed={row.done}
        variant="ghost"
        className={row.done ? "text-primary-text" : undefined}
        onClick={(e) => {
          // The card's own click opens the prototype; ticking it must not.
          e.stopPropagation();
          setState(row.name, { done: !row.done });
        }}
      />
    </ControlSizeProvider>
  );
}

/**
 * The detail pane header's Done toggle, beside the pin: the done circle in both
 * states — the accent ink once done, as the pin is once pinned — so ticking it
 * never moves the header. Disabled until the state is known, rather than
 * claiming "not done"; a failed read is the error icon, whose click retries.
 */
export function DoneHeaderAction() {
  const { name } = usePrototypeDetail();
  const read = usePrototypeState(name);
  const { setState } = useSetPrototypeState();
  if (read.status === "loading") {
    return (
      <TitleActionButton icon={checkCircleIcon} label="Mark as done" disabled />
    );
  }
  if (read.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        icon={checkCircleIcon}
        subject="the Done status"
        error={read.error}
        refetch={read.refetch}
      />
    );
  }
  const done = read.data.done;
  return (
    <TitleActionButton
      icon={checkCircleIcon}
      on={done}
      label={done ? "Done — click to reopen" : "Mark as done"}
      aria-pressed={done}
      onClick={() => setState(name, { done: !done })}
    />
  );
}
