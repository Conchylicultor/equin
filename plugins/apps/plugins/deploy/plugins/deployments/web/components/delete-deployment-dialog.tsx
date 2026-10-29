import type { ReactElement } from "react";
import {
  Button,
  DialogTitle,
  DialogDescription,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { deriveInstall, type Deployment } from "../../core";

/**
 * Confirm body for deleting a deployment record.
 *
 * The copy says exactly what the endpoint does and no more: the row is
 * forgotten, and the converged host keeps its unit, its files and its Caddy site
 * until someone tears it down — there is no de-converge verb. Naming the install
 * dir and the unit is the point: after this dialog they are the only trace, and
 * nothing in the app will name them again.
 */
export function DeleteDeploymentDialog({
  deployment,
  onCancel,
  onConfirm,
}: {
  deployment: Deployment;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const install = deriveInstall(deployment.compositionId);

  return (
    <Stack gap="md">
      <Stack gap="xs">
        <DialogTitle>Delete the {deployment.compositionId} deployment?</DialogTitle>
        <DialogDescription>
          This forgets the record only. Nothing on the server changes.
        </DialogDescription>
        <Text as="p" variant="body" tone="muted">
          The install keeps running: <Text as="code" variant="body">{install.unit}</Text>{" "}
          stays enabled and <Text as="code" variant="body">{install.installDir}</Text>{" "}
          stays on disk. There is no de-converge command — tear it down on the host
          if you want it gone.
        </Text>
      </Stack>
      <Stack direction="row" align="center" gap="sm">
        <Fill />
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          Delete deployment
        </Button>
      </Stack>
    </Stack>
  );
}
