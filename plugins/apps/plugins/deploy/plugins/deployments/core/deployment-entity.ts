import type { FieldsRecord } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { stringListField } from "@plugins/fields/plugins/string-list/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { deploymentIdKind } from "./id-kinds";

/**
 * A deployment's fields, in column order — the `deploy_deployments` table is
 * built from them (`server/internal/tables.ts`). Where a composition is served
 * and under what URL: `(composition × server) → { hostnames, loopbackPort }`.
 */
export const deploymentFields = {
  id: idKindField(deploymentIdKind),
  /**
   * A composition NAME from the `compositions` config. No FK to point at —
   * compositions are config_v2 data, not rows — so the create handler
   * validates membership at write time.
   */
  compositionId: textField({ label: "Composition" }),
  serverId: textField({ label: "Server" }),
  /**
   * Public hostnames Caddy serves this deployment on. Empty is legal: an
   * install can exist before DNS does. `exposure` is derived from this array
   * being non-empty, never declared — a deployment behind an open 443 with a
   * public hostname simply IS public, so there is no flag to typo.
   */
  hostnames: stringListField({ label: "Hostnames" }),
  loopbackPort: intField({ label: "Loopback port" }),
  createdAt: dateField({ label: "Created" }),
  updatedAt: dateField({ label: "Updated" }),
} satisfies FieldsRecord;

/** The `deploy_deployments` entity — every (composition × server) install. */
export const deployDeploymentsEntityRef = entityRef(
  "deploy_deployments",
  deploymentFields,
);
