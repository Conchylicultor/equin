import { createContext, useContext, type ReactElement } from "react";
import {
  defineItemActions,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { Version } from "@plugins/history/plugins/engine/core";

/** Row actions of the version timeline. */
export const VersionItemActions = defineItemActions<Version>();

/**
 * Who handles a Restore: the open dialog, which asks for confirmation first.
 * An action component receives only its row, so the dialog provides the handler
 * around its timeline.
 */
export const RestoreVersionContext = createContext<
  ((version: Version) => void) | null
>(null);

/** Restore — opens the dialog's confirmation for this version. */
export function RestoreVersionAction({
  row,
}: ItemActionProps<Version>): ReactElement {
  const onRestore = useContext(RestoreVersionContext);
  if (onRestore === null) {
    throw new Error(
      "RestoreVersionAction rendered outside a VersionHistoryDialog timeline",
    );
  }
  return (
    <Button
      variant="ghost"
      onClick={(e) => {
        e.stopPropagation();
        onRestore(row);
      }}
    >
      Restore
    </Button>
  );
}
