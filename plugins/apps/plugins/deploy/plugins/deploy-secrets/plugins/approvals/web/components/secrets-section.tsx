import { useMemo, type ReactElement } from "react";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { asPath, asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import {
  DEPLOY_SECRET_STATUSES,
  DEPLOY_SECRET_STATUS_LABELS,
  deploySecretsStatus,
  type DeploySecretStatus,
} from "../../core";
import { SecretItemActions, type SecretItem } from "../internal/items";

const SECRETS_VIEW = defineDataView("deploy.deployment.secrets");

const NO_ITEMS: SecretItem[] = [];

const STATUS_BADGE: Record<
  DeploySecretStatus,
  "success" | "warning" | "destructive"
> = {
  approved: "success",
  new: "warning",
  changed: "warning",
  "missing-value": "destructive",
};

/** Sentence-case, for a badge. */
function statusLabel(status: DeploySecretStatus): string {
  const label = DEPLOY_SECRET_STATUS_LABELS[status];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * The Secrets section of a deployment: every secret its composition's closure
 * declares, and whether this deployment may deliver it.
 *
 * A deploy is held (`needs-approval`) until every row is approved. Set value
 * stores the value locally; Approve is a separate, per-row click that grants
 * exactly the value shown to THIS deployment. Replacing a value makes every
 * deployment using it ask again.
 */
export function SecretsSection({
  deploymentId,
}: {
  deploymentId: string;
}): ReactElement {
  const result = useLive(deploySecretsStatus, { deploymentId });
  const items = foldResource(result, {
    loading: () => NO_ITEMS,
    error: () => NO_ITEMS,
    ready: (rows) => rows.map((r) => ({ ...r, deploymentId })),
  });

  const fields = useMemo<FieldDef<SecretItem>[]>(
    () => [
      {
        id: "key",
        label: "Key",
        type: "text",
        primary: true,
        value: (r) => r.key,
        sortable: true,
      },
      {
        id: "status",
        label: "Status",
        type: "enum",
        value: (r) => r.status,
        options: DEPLOY_SECRET_STATUSES.map((value) => ({
          value,
          label: statusLabel(value),
        })),
        cell: (r) => (
          <Badge variant={STATUS_BADGE[r.status]}>
            {statusLabel(r.status)}
          </Badge>
        ),
        filterable: true,
        groupable: true,
      },
      {
        id: "plugin",
        label: "Requested by",
        type: "text",
        value: (r) => r.plugins.map((p) => asPath(asPluginId(p))).join(", "),
      },
      {
        id: "description",
        label: "Description",
        type: "text",
        value: (r) => r.description,
      },
    ],
    [],
  );

  return (
    <Stack gap="sm">
      <Text as="p" variant="caption" tone="muted">
        A deploy waits until every secret below is approved for this deployment.
        A new or changed value is never delivered without your approval; a
        secret no longer needed is removed from the server on the next deploy.
      </Text>
      <DataView<SecretItem>
        rows={items}
        fields={fields}
        rowKey={(r) => r.key}
        // A table: the key is the row's identity and must never truncate behind
        // a long description, which a one-line list row does.
        views={["table"]}
        storageKey={SECRETS_VIEW}
        readiness={result}
        itemActions={SecretItemActions}
        emptyState="This composition needs no deploy secrets."
      />
    </Stack>
  );
}
