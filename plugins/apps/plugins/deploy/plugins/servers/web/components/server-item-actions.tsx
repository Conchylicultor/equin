import { type ReactElement } from "react";
import { defineItemActions } from "@plugins/primitives/plugins/data-view/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import type { ServerListRow } from "../../shared";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";

/** Per-consumer trailing-action slot for the deploy Servers list rows. */
export const ServerItemActions = defineItemActions<ServerListRow>();

/**
 * Opens the server's provider management console in a new tab. Rendered only
 * for rows that carry a `consoleUrl`; a server without one contributes no action.
 */
export function OpenConsoleAction({
  row,
}: ItemActionProps<ServerListRow>): ReactElement | null {
  const url = row.consoleUrl;
  if (!url) return null;
  return <NewTabButton href={url} label="Open console" />;
}
