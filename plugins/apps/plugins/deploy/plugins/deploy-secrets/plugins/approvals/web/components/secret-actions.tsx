import type { ReactElement } from "react";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useOpenDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { approveDeploySecret } from "../../core";
import type { SecretItem } from "../internal/items";
import { SetValueDialog } from "./set-value-dialog";
import { UseLocalValueDialog } from "./use-local-dialog";

const keyIcon = symbol("key");
const approveIcon = symbol("check");
const computerIcon = symbol("computer");

/** Enter or replace the value (shared by every deployment needing this key). */
export function SetValueAction({
  row,
}: ItemActionProps<SecretItem>): ReactElement {
  const openDialog = useOpenDialog();
  return (
    <IconButton
      icon={keyIcon}
      label={
        row.status === "missing-value" || row.status === "not-set"
          ? "Set value"
          : "Replace value"
      }
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
 * Use the value this computer already holds for this secret (a
 * `DeploySecrets.LocalValue` names where), instead of pasting it. Offered only
 * when there is one and it is not already the current value; a local value the
 * deploy cannot take says why. Opens a confirmation showing its preview.
 */
export function UseLocalValueAction({
  row,
}: ItemActionProps<SecretItem>): ReactElement | null {
  const openDialog = useOpenDialog();
  const local = row.local;
  if (local.kind === "none") return null;
  if (local.kind === "unusable") {
    return (
      <IconButton
        icon={computerIcon}
        label="Use this computer's value"
        tooltip={local.reason}
        disabled
      />
    );
  }
  if (local.sameAsCurrent) return null;
  return (
    <IconButton
      icon={computerIcon}
      label="Use this computer's value"
      tooltip={`Use the ${row.key} this computer already has (${local.preview})`}
      onClick={(e) => {
        e.stopPropagation();
        // Fire-and-forget: awaiting would pend the button for the dialog's life.
        void openDialog(
          (close) => (
            <UseLocalValueDialog
              item={row}
              preview={local.preview}
              fingerprint={local.fingerprint}
              caution={local.caution}
              close={close}
            />
          ),
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
      : row.status === "missing-value" ||
          row.status === "not-set" ||
          row.fingerprint === null
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
