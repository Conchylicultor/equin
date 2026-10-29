import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  DeploymentDetail,
  SiteBanner,
  SiteCheck,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { useSecretsBanner } from "./components/secrets-banner";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { SECRETS_SECTION_ID } from "../core";
import { SecretsSection } from "./components/secrets-section";
import { ApproveAction, SetValueAction } from "./components/secret-actions";
import { SecretItemActions } from "./internal/items";
import { useSecretsCheck } from "./internal/secrets-check";
import { useSecretsAvailable } from "./internal/use-secrets";

export default {
  description:
    "Secrets section of a site's Settings (and the site page's banner while a secret waits on approval): every deploy secret its composition's closure declares as a DataView (key, requesting plugin, description, status approved / new / value changed / missing value) with per-row Set value (a password dialog) and Approve (no approve-all). Shown only when the composition needs a secret.",
  contributions: [
    DeploymentDetail.Section({
      id: SECRETS_SECTION_ID,
      label: "Secrets",
      icon: symbol("key"),
      component: SecretsSection,
      useAvailable: useSecretsAvailable,
      // Settings reads top to bottom: every section starts open.
      useDefaultOpen: () => true,
    }),
    // The site page's banner while a secret waits on the user.
    SiteBanner({ id: "needs-secret", useBanner: useSecretsBanner }),
    SiteCheck({ id: "secrets", useCheck: useSecretsCheck }),
    SecretItemActions({ id: "set-value", component: SetValueAction }),
    SecretItemActions({ id: "approve", component: ApproveAction }),
  ],
  slots: { itemActions: SecretItemActions },
} satisfies PluginDefinition;
