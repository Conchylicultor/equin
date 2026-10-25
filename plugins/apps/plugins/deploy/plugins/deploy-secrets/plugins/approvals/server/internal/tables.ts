import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { _deployDeployments } from "@plugins/apps/plugins/deploy/plugins/deployments/server";
// The specific module, not the `core` barrel: drizzle-kit loads this file to
// build the schema, and the barrel carries endpoint and live descriptors.
import { deploySecretGrantsEntityRef } from "../../core/grants-entity";

// One deployment's approval of one secret's VALUE. Keyed by (deployment, key):
// a deployment approves at most one value per key, and approving a new one
// replaces the old grant. The value itself is never here — only its HMAC
// fingerprint (`fingerprint.ts`) — so a rotated value is simply a fingerprint
// no grant names, which is what makes "a rotation counts as new" a lookup
// rather than a rule. Cascades with the deployment: a grant is a promise about
// one box, and outlives nothing that box was.
const deploySecretGrantsEntity = defineEntity(deploySecretGrantsEntityRef, {
  primaryKey: ["deploymentId", "key"],
  columns: {
    deploymentId: {
      references: {
        column: () => _deployDeployments.id,
        onDelete: "cascade",
      },
    },
    approvedAt: { default: defaultNow() },
  },
});

export const _deploySecretGrants = deploySecretGrantsEntity.table;
