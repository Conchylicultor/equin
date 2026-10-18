import {
  mapResource,
  useCombinedResources,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { configValues } from "@plugins/config_v2/core";
import { useConfigRegistrations } from "@plugins/config_v2/web";
import type { IntegrationStatus } from "@plugins/auth/web";
import { configSecretMeta } from "@plugins/fields/plugins/secret/plugins/config/core";

/**
 * The Accounts row's status for Apple signing: configured once the certificate,
 * the App Store Connect key and the three text fields are all set, incomplete
 * once any is.
 */
export function useAppleSigningStatus(): ResourceResult<IntegrationStatus> {
  const registrations = useConfigRegistrations();
  const reg = registrations.find((r) => r.descriptor.name === "apple-signing");
  // The config is registered by apple-signing itself, so a missing
  // registration is a wiring bug — never "still loading". Both reads skip
  // (nothing subscribed), then the render throws.
  const path = reg ? { path: reg.storePath } : null;
  const both = useCombinedResources({
    meta: useLive(configSecretMeta, path),
    cfg: useLive(configValues, path),
  });
  if (!reg) {
    throw new Error(
      `[apple-signing setup] the "apple-signing" config has no web registration.`,
    );
  }
  return mapResource(both, ({ meta, cfg: raw }) => {
    const secretMeta = meta as Record<string, { set?: boolean } | undefined>;
    const cfg = (raw ?? {}) as {
      signingIdentity?: string;
      ascKeyId?: string;
      ascIssuerId?: string;
    };
    const p12Set = !!secretMeta.p12Cert?.set;
    const ascKeySet = !!secretMeta.ascApiKey?.set;
    const textComplete =
      !!cfg.signingIdentity && !!cfg.ascKeyId && !!cfg.ascIssuerId;
    if (p12Set && ascKeySet && textComplete) {
      return {
        tone: "success",
        label: "Configured",
        ...(cfg.signingIdentity ? { summary: cfg.signingIdentity } : {}),
      };
    }
    const anySet =
      p12Set ||
      ascKeySet ||
      !!cfg.signingIdentity ||
      !!cfg.ascKeyId ||
      !!cfg.ascIssuerId;
    return anySet
      ? { tone: "warning", label: "Incomplete" }
      : { tone: "muted", label: "Not configured" };
  });
}
