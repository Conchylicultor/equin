import type { ReactElement } from "react";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  Button,
  DialogDescription,
  DialogTitle,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useDeleteEventSource } from "@plugins/apps/plugins/events/plugins/events-core/web";
import type { EventSource } from "@plugins/apps/plugins/events/plugins/events-core/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const deleteIcon = symbol("delete");

/**
 * Delete a source from the list row.
 *
 * Confirmed, because the delete cascades: every event this source ever produced
 * goes with it, including any the user has looked at. There is no undo, so the
 * dialog says what leaves rather than asking "are you sure".
 */
export function SourceDeleteAction({
  row,
}: ItemActionProps<EventSource>): ReactElement {
  const remove = useDeleteEventSource();

  return (
    <IconButton
      icon={deleteIcon}
      label="Delete source"
      onClick={(e) => {
        e.stopPropagation();
        void openDialog((close) => (
          <ConfirmDelete
            source={row}
            onCancel={close}
            onConfirm={() => {
              remove.mutate({ params: { id: row.id } }, { onSuccess: close });
            }}
          />
        ));
      }}
    />
  );
}

function ConfirmDelete({
  source,
  onCancel,
  onConfirm,
}: {
  source: EventSource;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  return (
    <Stack gap="md" className="w-[28rem] max-w-full">
      <Stack gap="xs">
        <DialogTitle>Delete {source.name}?</DialogTitle>
        <DialogDescription>
          Every event this source collected is deleted with it, along with its
          run history. This cannot be undone.
        </DialogDescription>
      </Stack>
      <Line className="gap-sm">
        <Fill />
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          Delete source
        </Button>
      </Line>
    </Stack>
  );
}
