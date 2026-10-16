import { useState } from "react";
import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { PaneScroll } from "@plugins/primitives/plugins/pane/web";
import {
  Steps,
  Step,
  StepLink,
  StepDone,
  StepNote,
} from "@plugins/primitives/plugins/setup-steps/web";
import {
  fetchEndpoint,
  getEndpointErrorMessage,
} from "@plugins/infra/plugins/endpoints/web";
import { setApiKey } from "@plugins/auth/core";
import { useAccountStatus } from "@plugins/auth/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { GOOGLE_MAPS_PROVIDER_ID } from "@plugins/auth/plugins/google-maps/core";

const CONSOLE = "https://console.cloud.google.com";

/**
 * Accept either a bare project id or any pasted GCP console URL — every console
 * page carries the project as a `?project=` query param. Copied from the Google
 * OAuth wizard, whose users paste the same two things.
 */
function extractProjectId(raw: string): string {
  const match = raw.match(/[?&]project=([^&#]+)/);
  return match?.[1] ?? raw.trim();
}

export function GoogleMapsSetupPane() {
  const [projectId, setProjectId] = useState("");
  const [apiKey, setApiKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const status = useAccountStatus(GOOGLE_MAPS_PROVIDER_ID);

  const hasProject = projectId.length > 0;
  // Whether a key is stored is only claimed once the auth state is read; a
  // failed read says so on the key step (with Retry) instead of looking like
  // "no key yet".
  const connected = foldResource(status, {
    loading: () => false,
    error: () => false,
    ready: (account) => account?.connected ?? false,
  });

  async function handleSaveKey() {
    setSaving(true);
    setSaveError(null);
    try {
      await fetchEndpoint(
        setApiKey,
        { provider: GOOGLE_MAPS_PROVIDER_ID },
        { body: { apiKey } },
      );
      setApiKeyInput("");
    } catch (err) {
      // Central runs the live Places probe before storing anything, so a wrong,
      // unrestricted, unbilled or API-disabled key fails HERE, with Google's own
      // reason. Rendering it inline is the point — there is no separate Test.
      setSaveError(getEndpointErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <PaneScroll>
    <Stack gap="xl" className="p-lg max-w-lg">
      <Stack gap="xs">
        <Text as="label" variant="label">
          Google Cloud project ID
        </Text>
        <Input
          placeholder="my-project-123"
          value={projectId}
          onChange={(e) => setProjectId(extractProjectId(e.target.value))}
        />
        <Text as="p" variant="caption" className="text-muted-foreground">
          Paste any Google Cloud console URL, or type your project ID. Every
          link below opens straight at that project.
        </Text>
      </Stack>

      <Steps>
        <Step
          title="Create or select a Google Cloud project"
          state={hasProject ? "done" : "active"}
        >
          <Stack gap="sm">
            <StepLink href={`${CONSOLE}/projectcreate`} />
            <StepNote>
              Then paste the project ID (or the console URL) into the field
              above.
            </StepNote>
          </Stack>
        </Step>

        <Step
          title="Enable the Places API"
          state={hasProject ? "active" : "upcoming"}
        >
          <StepLink
            href={`${CONSOLE}/apis/library/places.googleapis.com?project=${projectId}`}
          />
        </Step>

        <Step
          title="Link a billing account"
          state={hasProject ? "active" : "upcoming"}
        >
          <Stack gap="sm">
            <StepLink
              href={`${CONSOLE}/billing/linkedaccount?project=${projectId}`}
            />
            <StepNote>
              This step is done by hand in the browser. Google offers no API and
              no CLI for creating or linking a billing account, so it cannot be
              automated and it cannot be skipped — the Places API returns an
              error for an unbilled project even inside the free allowance.
            </StepNote>
          </Stack>
        </Step>

        <Step
          title="Create an API key"
          state={hasProject ? "active" : "upcoming"}
        >
          <Stack gap="sm">
            <StepLink
              href={`${CONSOLE}/apis/credentials?project=${projectId}`}
            />
            <StepNote>
              Create credentials → API key. Then edit the key and restrict it to
              the Places API, so a leaked key cannot be spent on anything else.
            </StepNote>
          </Stack>
        </Step>

        <Step title="Paste the key" state={connected ? "done" : "active"}>
          <Stack gap="sm">
            {status.status === "error" && (
              <ResourceErrorInline
                variant="inline"
                subject="whether a key is stored"
                error={status.error}
                refetch={status.refetch}
              />
            )}
            {connected ? (
              <StepDone>
                Key stored and verified against the Places API
              </StepDone>
            ) : null}
            <Input
              type="password"
              placeholder="AIza…"
              value={apiKey}
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
            <Button
              variant="default"
              loading={saving}
              disabled={!apiKey}
              onClick={handleSaveKey}
            >
              {connected ? "Replace key" : "Save key"}
            </Button>
            {saveError ? (
              <Text as="p" variant="caption" className="text-destructive">
                {saveError}
              </Text>
            ) : null}
          </Stack>
        </Step>

        <Step title="Done" state={connected ? "done" : "upcoming"}>
          {connected ? (
            <StepDone>Google Maps Platform is connected</StepDone>
          ) : (
            <StepNote>
              This completes on its own once a key has been accepted.
            </StepNote>
          )}
        </Step>
      </Steps>
    </Stack>
    </PaneScroll>
  );
}
