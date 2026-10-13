import { createContext, useContext, type ReactElement } from "react";
import {
  defineItemActions,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { BroadcastEntry } from "../../shared/endpoints";

const deleteIcon = symbol("delete");

/** One broadcast as a row: the entry and its position in the file. */
export interface BroadcastRow {
  index: number;
  entry: BroadcastEntry;
}

/** Row actions of the broadcasts list. */
export const BroadcastItemActions = defineItemActions<BroadcastRow>();

/**
 * How a Delete reaches the file: the panel, which rewrites it from the entries
 * it read. `null` until that read lands (nothing to rewrite from yet). An
 * action component receives only its row, so the panel provides it around the
 * list.
 */
export const DeleteBroadcastContext = createContext<{
  saving: boolean;
  remove: (index: number) => Promise<void>;
} | null>(null);

/** Delete — removes this entry from the broadcasts file. */
export function DeleteBroadcastAction({
  row,
}: ItemActionProps<BroadcastRow>): ReactElement {
  const del = useContext(DeleteBroadcastContext);
  // Rows render only from a ready read, which is when the panel provides it.
  if (del === null) {
    throw new Error(
      "DeleteBroadcastAction rendered outside a ready BroadcastsPanel list",
    );
  }
  return (
    <ControlSizeProvider size="xs">
      <IconButton
        icon={deleteIcon}
        label="Delete"
        variant="ghost"
        className="text-muted-foreground hover:text-destructive"
        loading={del.saving}
        onClick={(e) => {
          e.stopPropagation();
          void del.remove(row.index);
        }}
      />
    </ControlSizeProvider>
  );
}
