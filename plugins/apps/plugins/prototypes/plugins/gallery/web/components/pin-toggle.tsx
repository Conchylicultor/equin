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

const keepIcon = symbol("keep");

// Pinning a prototype — one field of its state row
// (`apps/prototypes/state`, the instance's DB). A pinned prototype sorts
// first in its gallery section (and is the Pinned section when grouped by
// Status), whether or not it is Done.

/**
 * The card action's rest state: on while the prototype is pinned, so the
 * action stays painted at rest then and shows only on hover otherwise. A plain
 * read of the joined row — no subscription of its own.
 */
export function usePinnedActive(row: PrototypeGalleryRow): boolean {
  return row.pinned;
}

/**
 * The card's pin (a revealed item action that rests while pinned, beside
 * the Done circle). The row already carries `pinned` — the gallery joins the states
 * onto the list before it renders.
 */
export function PinCardAction({ row }: ItemActionProps<PrototypeGalleryRow>) {
  const { setState } = useSetPrototypeState();
  return (
    <ControlSizeProvider size="sm">
      <IconButton
        icon={keepIcon}
        active={row.pinned}
        label={row.pinned ? "Pinned — unpin" : "Pin"}
        aria-pressed={row.pinned}
        variant="ghost"
        className={row.pinned ? "text-primary-text" : undefined}
        onClick={(e) => {
          // The card's own click opens the prototype; pinning it must not.
          e.stopPropagation();
          setState(row.name, { pinned: !row.pinned });
        }}
      />
    </ControlSizeProvider>
  );
}

/**
 * The detail pane header's pin, beside the Done toggle: one glyph in both
 * states, the accent ink while pinned. Disabled until the state is known,
 * rather than claiming "not pinned"; a failed read is the error icon, whose
 * click retries.
 */
export function PinHeaderAction() {
  const { name } = usePrototypeDetail();
  const read = usePrototypeState(name);
  const { setState } = useSetPrototypeState();
  if (read.status === "loading") {
    return <TitleActionButton icon={keepIcon} label="Pin" disabled />;
  }
  if (read.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        icon={keepIcon}
        subject="the pinned status"
        error={read.error}
        refetch={read.refetch}
      />
    );
  }
  const pinned = read.data.pinned;
  return (
    <TitleActionButton
      icon={keepIcon}
      on={pinned}
      label={pinned ? "Pinned — click to unpin" : "Pin"}
      aria-pressed={pinned}
      onClick={() => setState(name, { pinned: !pinned })}
    />
  );
}
