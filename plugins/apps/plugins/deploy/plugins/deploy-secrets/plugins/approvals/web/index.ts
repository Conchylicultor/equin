import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DeploymentDetail } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { SECRETS_SECTION_ID } from "../core";
import { SecretsSection } from "./components/secrets-section";
import { ApproveAction, SetValueAction } from "./components/secret-actions";
import { SecretItemActions } from "./internal/items";
import {
  useSecretsAvailable,
  useSecretsDefaultOpen,
} from "./internal/use-secrets";

export default {
  description:
    "Secrets section of a deployment's page: every deploy secret its composition's closure declares as a DataView (key, requesting plugin, description, status approved / new / value changed / missing value) with per-row Set value (a password dialog) and Approve (no approve-all). Shown only when the composition needs a secret, and open by default while one waits on the user.",
  contributions: [
    DeploymentDetail.Section({
      id: SECRETS_SECTION_ID,
      label: "Secrets",
      icon: symbol("key"),
      component: SecretsSection,
      useAvailable: useSecretsAvailable,
      useDefaultOpen: useSecretsDefaultOpen,
    }),
    SecretItemActions({ id: "set-value", component: SetValueAction }),
    SecretItemActions({ id: "approve", component: ApproveAction }),
  ],
  slots: { itemActions: SecretItemActions },
} satisfies PluginDefinition;
