import type { ReactElement } from "react";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { approveDeploySecret } from "../../core";
import type { SecretItem } from "../internal/items";
import { SetValueDialog } from "./set-value-dialog";

const keyIcon = symbol("key");
const approveIcon = symbol("check");

/** Enter or replace the value (shared by every deployment needing this key). */
export function SetValueAction({
  row,
}: ItemActionProps<SecretItem>): ReactElement {
  return (
    <IconButton
      icon={keyIcon}
      label={row.status === "missing-value" ? "Set value" : "Replace value"}
      onClick={(e) => {
        e.stopPropagation();
        // Fire-and-forget: awaiting would pend the button for the dialog's life.
        void openDialog(
          (close) => <SetValueDialog item={row} close={close} />,
          { size: "sm" },
        );
      }}
    />
  );
}

/**
 * Approve the value currently set, for THIS deployment only. Per row and
 * deliberate — there is no approve-all. It sends the fingerprint the row
 * showed, so a value replaced since is refused rather than approved blind.
 */
export function ApproveAction({
  row,
}: ItemActionProps<SecretItem>): ReactElement {
  const approve = useEndpointMutation(approveDeploySecret);
  const reason =
    row.status === "approved"
      ? "Already approved for this deployment"
      : row.status === "missing-value" || row.fingerprint === null
        ? "Set a value first"
        : null;
  const fingerprint = row.fingerprint;
  return (
    <IconButton
      icon={approveIcon}
      label="Approve"
      tooltip={
        reason ??
        `Approve this value of ${row.key} for this deployment — the next deploy delivers it to the server`
      }
      disabled={reason !== null || fingerprint === null || approve.isPending}
      onClick={(e) => {
        e.stopPropagation();
        if (fingerprint === null) return;
        approve.mutate({
          params: { deploymentId: row.deploymentId },
          body: { key: row.key, fingerprint },
        });
      }}
    />
  );
}
