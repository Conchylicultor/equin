import type { ReactElement } from "react";
import {
  defineItemActions,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { installDepEndpoint, removeDepEndpoint, type DepRow } from "../../core";

const downloadIcon = symbol("download");
const deleteIcon = symbol("delete");

/** Row actions of the Dependencies view. */
export const DepItemActions = defineItemActions<DepRow>();

/**
 * Install (or retry) a dependency. The request only enqueues the install job;
 * the row's state moves through `installing` to `ready` as the job writes it.
 */
export function InstallDepAction({
  row,
}: ItemActionProps<DepRow>): ReactElement | null {
  const install = useEndpointMutation(installDepEndpoint);
  const kind = row.state.kind;
  if (install.kind === "unavailable") return null;
  if (kind === "ready" || kind === "installing") return null;
  return (
    <IconButton
      icon={downloadIcon}
      label={kind === "failed" ? "Retry install" : "Install"}
      tooltip={`Install ${row.id} (${row.sizeHint}) in the background`}
      disabled={install.isPending}
      onClick={(e) => {
        e.stopPropagation();
        install.mutate({ body: { id: row.id } });
      }}
    />
  );
}

/** Remove the install at its current identity, back to `absent`. */
export function RemoveDepAction({
  row,
}: ItemActionProps<DepRow>): ReactElement | null {
  const remove = useEndpointMutation(removeDepEndpoint);
  if (remove.kind === "unavailable") return null;
  if (row.state.kind !== "ready" && row.state.kind !== "failed") return null;
  return (
    <IconButton
      icon={deleteIcon}
      label="Remove"
      tooltip={`Remove ${row.id}'s install; it is installed again on next use`}
      disabled={remove.isPending}
      onClick={(e) => {
        e.stopPropagation();
        remove.mutate({ body: { id: row.id } });
      }}
    />
  );
}
