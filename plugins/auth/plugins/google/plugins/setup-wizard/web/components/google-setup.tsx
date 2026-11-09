import {
  ResourceErrorInline,
  useCombinedResources,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState } from "react";
import {
  useAccountStatus,
  startConnectFlow,
  currentWorktreeName,
} from "@plugins/auth/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useTransport } from "@plugins/primitives/plugins/networking/web";
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
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";

const REDIRECT_URI = "http://localhost:9000/api/auth/callback/google";

function extractProjectId(raw: string): string {
  const match = raw.match(/[?&]project=([^&#]+)/);
  return match?.[1] ?? raw.trim();
}

/** Google's setup, rendered inline in the Google Accounts pane (`setup: { kind: "steps" }`). */
export function GoogleSetup() {
  const fetchEndpoint = useFetchEndpoint();
  const transport = useTransport();
  const [projectId, setProjectId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const registrations = useConfigRegistrations();
  const reg = registrations.find((r) => r.descriptor.name === "auth-google");
  const metaResult = useLive(
    configSecretMeta,
    reg ? { path: reg.storePath } : null,
  );
  const statusResult = useAccountStatus("google");
  // Both reads decide what the wizard claims (credentials saved, account
  // connected), so it waits for both — and a failure of either says so.
  const reads = useCombinedResources({
    meta: metaResult,
    status: statusResult,
  });
  // The config is registered by auth/google itself, so a missing registration
  // is a wiring bug — never "still loading": the read above skipped, and the
  // render throws.
  if (!reg) {
    throw new Error(
      `[google setup] the "auth-google" config has no web registration.`,
    );
  }
  const storePath = reg.storePath;
  if (reads.status === "loading") return <Loading />;
  // The secrets are the computer's: a subtree with none (the demo) says so.
  if (reads.status === "unavailable")
    return <Placeholder>{reads.message}</Placeholder>;
  if (reads.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the Google connection state"
        error={reads.error}
        refetch={reads.refetch}
      />
    );
  }
  const { meta: secretMeta, status } = reads.data;
  const credentialsSaved =
    !!secretMeta.clientId?.set && !!secretMeta.clientSecret?.set;
  const connected = status?.connected;

  function handleProjectInput(raw: string) {
    setProjectId(extractProjectId(raw));
  }

  async function handleSaveCredentials() {
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
      const result = await startConnectFlow(transport, {
        providerId: "google",
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

  const hasProject = projectId.length > 0;

  return (
    <Stack gap="xl">
      <Stack gap="xs">
        <Text as="label" variant="label">
          GCP Project ID
        </Text>
        <Input
          placeholder="my-project-123"
          value={projectId}
          onChange={(e) => handleProjectInput(e.target.value)}
        />
        <Text as="p" variant="caption" className="text-muted-foreground">
          Paste any GCP console URL, or type your project ID
        </Text>
      </Stack>

      <Steps>
        <Step
          title="Select or create a GCP project"
          state={hasProject ? "done" : "active"}
        >
          <StepLink href="https://console.cloud.google.com/projectcreate" />
        </Step>

        <Step
          title="Enable Google Drive API"
          state={hasProject ? "active" : "upcoming"}
        >
          <StepLink
            href={`https://console.cloud.google.com/apis/library/drive.googleapis.com?project=${projectId}`}
          />
        </Step>

        <Step
          title="Set up OAuth consent screen"
          state={hasProject ? "active" : "upcoming"}
        >
          <StepLink
            href={`https://console.cloud.google.com/auth/overview?project=${projectId}`}
          />
        </Step>

        <Step
          title="Publish the app"
          state={hasProject ? "active" : "upcoming"}
        >
          <Stack gap="sm">
            <StepNote>
              While the app is in <span className="font-medium">Testing</span>,
              Google expires its access 7 days after you connect, and backups
              stop until you reconnect. Publishing keeps the connection; a
              personal app needs no Google review for it.
            </StepNote>
            <StepNote>
              First fill Branding: app name, support email, a home page and a
              privacy policy link (any page you control), and add their domain
              under Authorized domains.
            </StepNote>
            <StepLink
              href={`https://console.cloud.google.com/auth/branding?project=${projectId}`}
            />
            <StepNote>
              Then on Audience, click{" "}
              <span className="font-medium">Publish app</span>.
            </StepNote>
            <StepLink
              href={`https://console.cloud.google.com/auth/audience?project=${projectId}`}
            />
          </Stack>
        </Step>

        <Step
          title="Create OAuth 2.0 credentials"
          state={hasProject ? "active" : "upcoming"}
        >
          <Stack gap="sm">
            <StepLink
              href={`https://console.cloud.google.com/auth/clients/create?project=${projectId}`}
            />
            <StepNote>
              Application type: <span className="font-medium">Desktop app</span>
            </StepNote>
            <StepCommand text={REDIRECT_URI} title="Copy redirect URI" />
            <StepNote>Add this as the Authorized redirect URI</StepNote>
          </Stack>
        </Step>

        <Step
          title="Enter credentials"
          state={credentialsSaved ? "done" : "active"}
        >
          <Stack gap="sm">
            {credentialsSaved ? (
              <StepDone>Credentials configured</StepDone>
            ) : (
              <>
                <Input
                  type="password"
                  placeholder="Client ID"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
                <Input
                  type="password"
                  placeholder="Client Secret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
                <Button
                  variant="default"
                  loading={saving}
                  disabled={!clientId && !clientSecret}
                  onClick={handleSaveCredentials}
                >
                  Save
                </Button>
              </>
            )}
          </Stack>
        </Step>

        <Step
          title="Connect your account"
          state={connected ? "done" : credentialsSaved ? "active" : "upcoming"}
        >
          <Stack gap="sm">
            {connected ? (
              <StepDone>
                Connected
                {status?.identity?.email ? ` (${status.identity.email})` : ""}
              </StepDone>
            ) : (
              <>
                <Button
                  variant="default"
                  disabled={connecting}
                  onClick={handleConnect}
                >
                  {connecting ? "Connecting…" : "Connect with Google"}
                </Button>
                {connectError ? (
                  <Text as="p" variant="caption" className="text-destructive">
                    {connectError}
                  </Text>
                ) : null}
              </>
            )}
          </Stack>
        </Step>
      </Steps>
    </Stack>
  );
}
