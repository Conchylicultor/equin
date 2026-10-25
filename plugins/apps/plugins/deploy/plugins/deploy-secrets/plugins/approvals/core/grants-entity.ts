import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { idKindField } from "@plugins/ids/core";
import { deploymentIdKind } from "@plugins/apps/plugins/deploy/plugins/deployments/core";

/**
 * One deployment's approval of one secret's value: `(deploymentId, key) →
 * valueFingerprint`. The fingerprint is an HMAC of the value under a local key
 * (`server/internal/fingerprint.ts`), so this table never holds a secret, and
 * a rotated value is simply a different fingerprint — i.e. not approved.
 */
export const deploySecretGrantsEntityRef = entityRef("deploy_secret_grants", {
  deploymentId: idKindField(deploymentIdKind, { label: "Deployment" }),
  key: textField({ label: "Key" }),
  valueFingerprint: textField({ label: "Value fingerprint" }),
  approvedAt: dateField({ label: "Approved" }),
});
