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

const keepIcon = symbol("keep");

// Pinning a prototype — one field of its shared status record
// (`set-status.ts`). A pinned prototype is grouped in the gallery's Pinned
// section, above In progress and Done, whether or not it is Done.

/**
 * The card's at-rest pin (a `persistent` item action, beside the Done
 * checkbox). The row already carries `pinned` — the gallery joins the statuses
 * onto the list before it renders.
 */
export function PinCardAction({ row }: ItemActionProps<PrototypeGalleryRow>) {
  const { pending, setStatus } = useSetPrototypeStatus();
  return (
    <ControlSizeProvider size="sm">
      <IconButton
        icon={keepIcon}
        active={row.pinned}
        label={row.pinned ? "Pinned — unpin" : "Pin"}
        aria-pressed={row.pinned}
        variant="ghost"
        loading={pending}
        className={row.pinned ? "text-primary-text" : undefined}
        onClick={(e) => {
          // The card's own click opens the prototype; pinning it must not.
          e.stopPropagation();
          setStatus(row.name, { pinned: !row.pinned });
        }}
      />
    </ControlSizeProvider>
  );
}

/**
 * The detail pane header's pin, beside the Done toggle: one glyph in both
 * states, the accent ink while pinned. Disabled until the statuses are known,
 * rather than claiming "not pinned"; a failed read is the error icon, whose
 * click retries.
 */
export function PinHeaderAction() {
  const { name } = usePrototypeDetail();
  const statuses = useLive(prototypeStatuses);
  const { pending, setStatus } = useSetPrototypeStatus();
  if (statuses.status === "loading") {
    return <TitleActionButton icon={keepIcon} label="Pin" disabled />;
  }
  if (statuses.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        icon={keepIcon}
        subject="the pinned status"
        error={statuses.error}
        refetch={statuses.refetch}
      />
    );
  }
  const pinned = statusOf(statuses.data, name).pinned;
  return (
    <TitleActionButton
      icon={keepIcon}
      on={pinned}
      label={pinned ? "Pinned — click to unpin" : "Pin"}
      aria-pressed={pinned}
      loading={pending}
      onClick={() => setStatus(name, { pinned: !pinned })}
    />
  );
}
