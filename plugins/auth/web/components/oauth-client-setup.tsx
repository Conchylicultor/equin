import { useState } from "react";
import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  ResourceErrorInline,
  foldResource,
} from "@plugins/primitives/plugins/live-state/web";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { setConfigField } from "@plugins/config_v2/core";
import { useConfigRegistrations } from "@plugins/config_v2/web";
import { configSecretMeta } from "@plugins/fields/plugins/secret/plugins/config/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  Steps,
  Step,
  StepLink,
  StepDone,
  StepNote,
  StepCommand,
} from "@plugins/primitives/plugins/setup-steps/web";
import type { AuthAccountState } from "@plugins/auth/core";
import type { ProviderSetup } from "../slots";
import { currentWorktreeName, startConnectFlow } from "../connect";

/**
 * Bare localhost, not the worktree subdomain: the gateway forwards
 * `/api/auth/callback/*` to central from there (see the auth CLAUDE.md).
 */
function redirectUri(providerId: string): string {
  return `http://localhost:9000/api/auth/callback/${providerId}`;
}

/**
 * The generic setup of an OAuth provider whose client the user registers
 * themselves: create the app in the provider's console, give it our redirect
 * URI, paste its client id + secret (stored as the provider's secret config
 * fields), connect.
 */
export function OAuthClientSetup({
  providerId,
  providerName,
  setup,
  status,
}: {
  providerId: string;
  providerName: string;
  setup: Extract<ProviderSetup, { kind: "oauth-client" }>;
  status: AuthAccountState;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const reg = useConfigRegistrations().find(
    (r) => r.descriptor.name === setup.config.name,
  );
  const meta = useLive(configSecretMeta, reg ? { path: reg.storePath } : null);
  // The provider registers its own config (`ConfigV2.WebRegister`), so a
  // missing registration is a wiring bug — never "still loading": the read
  // above skipped, and the render throws.
  if (!reg) {
    throw new Error(
      `auth: the "${setup.config.name}" config of provider "${providerId}" has no web registration — add ConfigV2.WebRegister({ descriptor }) to the provider's web plugin.`,
    );
  }
  const storePath = reg.storePath;
  const appNoun = setup.appNoun ?? "OAuth app";
  // Whether credentials are saved is claimed only once read; a failed read
  // says so on the credentials step (with Retry) instead of looking unsaved.
  const credentialsSaved = foldResource(meta, {
    loading: () => false,
    error: () => false,
    ready: (m) => !!m.clientId?.set && !!m.clientSecret?.set,
  });

  async function handleSave() {
    setSaving(true);
    try {
      if (clientId)
        await fetchEndpoint(
          setConfigField,
          {},
          { body: { storePath, key: "clientId", value: clientId } },
        );
      if (clientSecret)
        await fetchEndpoint(
          setConfigField,
          {},
          { body: { storePath, key: "clientSecret", value: clientSecret } },
        );
      setClientId("");
      setClientSecret("");
    } finally {
      setSaving(false);
    }
  }

  async function handleConnect() {
    setConnecting(true);
    setConnectError(null);
    try {
      const result = await startConnectFlow({
        providerId,
        worktree: currentWorktreeName(),
      });
      if (!result.ok && result.message && result.message !== "cancelled") {
        setConnectError(result.message);
      }
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <Steps>
      <Step
        title={`Create a ${appNoun}`}
        state={credentialsSaved ? "done" : "active"}
      >
        <Stack gap="sm">
          <StepLink href={setup.consoleUrl} />
          {setup.consoleNote ? <StepNote>{setup.consoleNote}</StepNote> : null}
        </Stack>
      </Step>

      <Step
        title="Add the redirect URI"
        state={credentialsSaved ? "done" : "active"}
      >
        <Stack gap="sm">
          <StepCommand
            text={redirectUri(providerId)}
            title="Copy redirect URI"
          />
          <StepNote>Paste it as the {appNoun}&apos;s redirect URI.</StepNote>
        </Stack>
      </Step>

      <Step
        title="Enter the client ID and secret"
        state={credentialsSaved ? "done" : "active"}
      >
        <Stack gap="sm">
          {meta.status === "error" ? (
            <ResourceErrorInline
              variant="inline"
              subject="whether credentials are saved"
              error={meta.error}
              refetch={meta.refetch}
            />
          ) : null}
          {credentialsSaved ? <StepDone>Credentials saved</StepDone> : null}
          <Input
            type="password"
            placeholder="Client ID"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
          <Input
            type="password"
            placeholder="Client secret"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
          <Button
            variant={credentialsSaved ? "outline" : "default"}
            loading={saving}
            disabled={!clientId && !clientSecret}
            onClick={handleSave}
          >
            {credentialsSaved ? "Replace credentials" : "Save"}
          </Button>
        </Stack>
      </Step>

      <Step
        title="Connect your account"
        state={
          status.connected ? "done" : credentialsSaved ? "active" : "upcoming"
        }
      >
        <Stack gap="sm">
          {status.connected ? (
            <StepDone>{providerName} is connected</StepDone>
          ) : (
            <>
              <Button
                variant="default"
                loading={connecting}
                onClick={handleConnect}
              >
                Connect with {providerName}
              </Button>
              {connectError ? (
                <Text as="p" variant="caption" tone="destructive">
                  {connectError}
                </Text>
              ) : null}
            </>
          )}
        </Stack>
      </Step>
    </Steps>
  );
}
