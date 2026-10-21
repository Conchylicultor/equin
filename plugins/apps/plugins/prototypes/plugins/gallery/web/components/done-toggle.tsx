import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  prototypeStatuses,
  statusOf,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  TitleActionButton,
  usePrototypeDetail,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import type { PrototypeGalleryRow } from "../slots";
import { useSetPrototypeStatus } from "./set-status";
import { symbol } from "@plugins/ui/plugins/icons/core";

const checkCircleIcon = symbol("check-circle");
const radioButtonUncheckedIcon = symbol("radio-button-unchecked");

// Marking a prototype Done — one field of its shared status record
// (`set-status.ts`).

/**
 * The card's at-rest checkbox (a `persistent` item action, so it is painted in
 * every card's footer, not only on hover). The row already carries `done` —
 * the gallery joins the statuses onto the list before it renders.
 */
export function DoneCardAction({ row }: ItemActionProps<PrototypeGalleryRow>) {
  const { pending, setStatus } = useSetPrototypeStatus();
  return (
    <ControlSizeProvider size="sm">
      <IconButton
        icon={row.done ? checkCircleIcon : radioButtonUncheckedIcon}
        label={row.done ? "Done — mark as not done" : "Mark as done"}
        aria-pressed={row.done}
        variant="ghost"
        loading={pending}
        className={row.done ? "text-primary-text" : undefined}
        onClick={(e) => {
          // The card's own click opens the prototype; ticking it must not.
          e.stopPropagation();
          setStatus(row.name, { done: !row.done });
        }}
      />
    </ControlSizeProvider>
  );
}

/**
 * The detail pane header's Done toggle, beside the pin: the done circle in both
 * states — the accent ink once done, as the pin is once pinned — so ticking it
 * never moves the header. Disabled until the statuses are known, rather than
 * claiming "not done"; a failed read is the error icon, whose click retries.
 */
export function DoneHeaderAction() {
  const { name } = usePrototypeDetail();
  const statuses = useLive(prototypeStatuses);
  const { pending, setStatus } = useSetPrototypeStatus();
  if (statuses.status === "loading") {
    return (
      <TitleActionButton icon={checkCircleIcon} label="Mark as done" disabled />
    );
  }
  if (statuses.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        icon={checkCircleIcon}
        subject="the Done status"
        error={statuses.error}
        refetch={statuses.refetch}
      />
    );
  }
  const done = statusOf(statuses.data, name).done;
  return (
    <TitleActionButton
      icon={checkCircleIcon}
      on={done}
      label={done ? "Done — click to reopen" : "Mark as done"}
      aria-pressed={done}
      loading={pending}
      onClick={() => setStatus(name, { done: !done })}
    />
  );
}
