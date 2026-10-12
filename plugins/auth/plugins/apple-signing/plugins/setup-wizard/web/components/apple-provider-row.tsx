import { Icon } from "@plugins/ui/plugins/icons/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  matchResource,
  ResourceErrorInline,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { configValues } from "@plugins/config_v2/core";
import { useConfigRegistrations } from "@plugins/config_v2/web";
import { Auth } from "@plugins/auth/web";
import type { AuthProviderRowProps } from "@plugins/auth/web";
import { configSecretMeta } from "@plugins/fields/plugins/secret/plugins/config/core";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { appleSetupPane } from "../panes";

export function AppleProviderRow({ providerId }: AuthProviderRowProps) {
  const providers = Auth.Provider.useContributions();
  const openPane = useOpenPane();
  const setup = openPane.to(appleSetupPane, {}, { mode: "root" });
  const provider = providers.find((p) => p.id === providerId);

  const registrations = useConfigRegistrations();
  const reg = registrations.find((r) => r.descriptor.name === "apple-signing");
  // The config is registered by apple-signing itself, so a missing
  // registration is a wiring bug — never "still loading". Both reads skip
  // (nothing subscribed), then the render throws.
  const path = reg ? { path: reg.storePath } : null;
  const metaResult = useLive(configSecretMeta, path);
  const cfgResult = useLive(configValues, path);
  const both = useCombinedResources({ meta: metaResult, cfg: cfgResult });
  if (!reg) {
    throw new Error(
      `[apple-signing setup] the "apple-signing" config has no web registration.`,
    );
  }

  if (!provider) return null;
  const icon = provider.icon;

  return (
    <Stack direction="row" gap="lg" align="start" className="p-lg">
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- top offset to baseline-align icon with adjacent text */}
      <Icon icon={icon} className="mt-1 size-6" />
      <Fill>
        {matchResource(both, {
          loading: () => <Loading variant="text" />,
          error: (error) => (
            <ResourceErrorInline
              variant="inline"
              subject="the signing setup"
              error={error}
              refetch={both.refetch}
            />
          ),
          ready: ({ meta, cfg }) => (
            <Body
              secretMeta={meta}
              cfg={
                (cfg ?? {}) as {
                  signingIdentity?: string;
                  ascKeyId?: string;
                  ascIssuerId?: string;
                }
              }
              name={provider.name}
              setup={setup}
            />
          ),
        })}
      </Fill>
    </Stack>
  );
}

function Body({
  secretMeta,
  cfg,
  name,
  setup,
}: {
  secretMeta: Record<string, { set?: boolean } | undefined>;
  cfg: { signingIdentity?: string; ascKeyId?: string; ascIssuerId?: string };
  name: string;
  /** The setup wizard, as a link. */
  setup: LinkTarget;
}) {
  const p12Set = !!secretMeta.p12Cert?.set;
  const ascKeySet = !!secretMeta.ascApiKey?.set;
  const textComplete =
    !!cfg.signingIdentity && !!cfg.ascKeyId && !!cfg.ascIssuerId;
  const allSet = p12Set && ascKeySet && textComplete;
  const anySet =
    p12Set ||
    ascKeySet ||
    !!cfg.signingIdentity ||
    !!cfg.ascKeyId ||
    !!cfg.ascIssuerId;

  const pill = allSet ? (
    <Badge variant="success">Signing configured</Badge>
  ) : anySet ? (
    <Badge variant="warning">Incomplete</Badge>
  ) : (
    <Badge variant="muted">Not configured</Badge>
  );

  const label = allSet ? "Manage" : anySet ? "Finish setup" : "Configure";

  return (
    <Stack direction="row" gap="lg" align="start">
      <Fill>
        <Stack gap="xs">
          <Stack direction="row" align="center" gap="sm">
            <span className="font-medium">{name}</span>
            {pill}
          </Stack>
          {allSet && cfg.signingIdentity ? (
            <Text
              as="div"
              variant="body"
              className="text-muted-foreground truncate"
            >
              {cfg.signingIdentity}
            </Text>
          ) : (
            <Text as="div" variant="caption" className="text-muted-foreground">
              Sign &amp; notarize desktop releases with a Developer ID.
            </Text>
          )}
        </Stack>
      </Fill>
      <Button variant={allSet ? "outline" : "default"} {...linkProps(setup)}>
        {label}
      </Button>
    </Stack>
  );
}
