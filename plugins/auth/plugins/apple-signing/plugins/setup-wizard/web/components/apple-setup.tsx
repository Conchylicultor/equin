import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState } from "react";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  ResourceErrorInline,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { configValues, setConfigField } from "@plugins/config_v2/core";
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
} from "@plugins/primitives/plugins/setup-steps/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { setAppleCertificateEndpoint } from "@plugins/auth/plugins/apple-signing/core";

async function fileToBase64(file: File): Promise<string> {
  return btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
}

/** Apple signing's setup, the body of its Accounts pane (the integration's `setup`). */
export function AppleSetup() {
  const fetchEndpoint = useFetchEndpoint();
  const [password, setPassword] = useState("");
  const [p12Base64, setP12Base64] = useState("");
  const [p12FileName, setP12FileName] = useState("");
  const [savingCert, setSavingCert] = useState(false);
  const [certError, setCertError] = useState<string | null>(null);
  const [manualIdentity, setManualIdentity] = useState("");

  const [p8FileName, setP8FileName] = useState("");
  const [p8Pem, setP8Pem] = useState("");
  const [keyId, setKeyId] = useState("");
  const [issuerId, setIssuerId] = useState("");
  const [savingKey, setSavingKey] = useState(false);

  const registrations = useConfigRegistrations();
  const reg = registrations.find((r) => r.descriptor.name === "apple-signing");
  // The config is registered by apple-signing itself, so a missing
  // registration is a wiring bug — never "still loading". Both reads skip
  // (nothing subscribed), then the render throws.
  const path = reg ? { path: reg.storePath } : null;
  const metaResult = useLive(configSecretMeta, path);
  const cfgResult = useLive(configValues, path);
  if (!reg) {
    throw new Error(
      `[apple-signing setup] the "apple-signing" config has no web registration.`,
    );
  }
  const storePath = reg.storePath;

  const both = useCombinedResources({ meta: metaResult, cfg: cfgResult });
  if (both.status === "loading") return <Loading />;
  // The secrets are the computer's: a subtree with none (the demo) says so.
  if (both.status === "unavailable")
    return <Placeholder>{both.message}</Placeholder>;
  if (both.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the signing setup"
        error={both.error}
        refetch={both.refetch}
      />
    );
  }
  const secretMeta = both.data.meta;
  const cfg = (both.data.cfg ?? {}) as {
    signingIdentity?: string;
    ascKeyId?: string;
    ascIssuerId?: string;
  };

  const p12Set = !!secretMeta.p12Cert?.set;
  const ascKeySet = !!secretMeta.ascApiKey?.set;
  const identity = cfg.signingIdentity;
  const certDone = p12Set && !!identity;
  // Derivation failed (or not yet attempted after upload): cert stored but no
  // identity → reveal a manual identity field.
  const needsManualIdentity = p12Set && !identity;
  const apiKeyDone = ascKeySet && !!cfg.ascKeyId && !!cfg.ascIssuerId;
  const allDone = certDone && apiKeyDone;

  async function handleP12File(file: File | undefined) {
    if (!file) return;
    setCertError(null);
    setP12FileName(file.name);
    setP12Base64(await fileToBase64(file));
  }

  async function handleSaveCert() {
    if (!p12Base64) return;
    setSavingCert(true);
    setCertError(null);
    try {
      const res = await fetchEndpoint(
        setAppleCertificateEndpoint,
        {},
        { body: { p12Base64, password } },
      );
      if (res.signingIdentity === null) {
        setCertError(
          "Could not read the signing identity from the certificate. Enter it manually below.",
        );
      }
      setPassword("");
      setP12Base64("");
      setP12FileName("");
    } finally {
      setSavingCert(false);
    }
  }

  async function handleSaveManualIdentity() {
    if (!manualIdentity) return;
    await fetchEndpoint(
      setConfigField,
      {},
      { body: { storePath, key: "signingIdentity", value: manualIdentity } },
    );
    setManualIdentity("");
  }

  async function handleP8File(file: File | undefined) {
    if (!file) return;
    setP8FileName(file.name);
    setP8Pem(await file.text());
  }

  async function handleSaveApiKey() {
    setSavingKey(true);
    try {
      if (p8Pem)
        await fetchEndpoint(
          setConfigField,
          {},
          { body: { storePath, key: "ascApiKey", value: p8Pem } },
        );
      if (keyId)
        await fetchEndpoint(
          setConfigField,
          {},
          { body: { storePath, key: "ascKeyId", value: keyId } },
        );
      if (issuerId)
        await fetchEndpoint(
          setConfigField,
          {},
          { body: { storePath, key: "ascIssuerId", value: issuerId } },
        );
      setP8Pem("");
      setP8FileName("");
      setKeyId("");
      setIssuerId("");
    } finally {
      setSavingKey(false);
    }
  }

  return (
    <Stack gap="xl">
      <Text as="p" variant="caption" className="text-muted-foreground">
        Configure Developer ID signing so the next Desktop (Tauri) release is
        signed and notarized. Credentials are stored encrypted on this machine.
      </Text>

      <Steps>
        <Step title="Enrolled in the Apple Developer Program" state="active">
          <StepLink href="https://developer.apple.com/account" />
        </Step>

        <Step
          title="Create a Developer ID Application certificate"
          state={p12Set ? "done" : "active"}
        >
          <Stack gap="sm">
            <StepLink href="https://developer.apple.com/account/resources/certificates/list" />
            <StepNote>
              Download it, then in Keychain Access → right-click the cert →
              Export as .p12 with a password.
            </StepNote>
          </Stack>
        </Step>

        <Step title="Upload certificate" state={certDone ? "done" : "active"}>
          <Stack gap="sm">
            {certDone ? (
              <StepDone>
                Signing identity: <span className="font-mono">{identity}</span>
              </StepDone>
            ) : (
              <>
                <input
                  type="file"
                  accept=".p12"
                  onChange={(e) => void handleP12File(e.target.files?.[0])}
                  className="text-caption"
                />
                {p12FileName ? (
                  <StepNote>
                    Selected: <span className="font-mono">{p12FileName}</span>
                  </StepNote>
                ) : null}
                <Input
                  type="password"
                  placeholder="Certificate password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Button
                  variant="default"
                  loading={savingCert}
                  disabled={!p12Base64}
                  onClick={handleSaveCert}
                >
                  Save certificate
                </Button>
                {certError ? (
                  <Text as="p" variant="caption" className="text-warning">
                    {certError}
                  </Text>
                ) : null}
                {needsManualIdentity ? (
                  <>
                    <Input
                      placeholder="Signing identity (e.g. Developer ID Application: Name (TEAMID))"
                      value={manualIdentity}
                      onChange={(e) => setManualIdentity(e.target.value)}
                    />
                    <Button
                      variant="outline"
                      disabled={!manualIdentity}
                      onClick={handleSaveManualIdentity}
                    >
                      Save identity
                    </Button>
                  </>
                ) : null}
                <StepNote>Stored encrypted on this machine.</StepNote>
              </>
            )}
          </Stack>
        </Step>

        <Step
          title="Create an App Store Connect API key"
          state={certDone ? "active" : "upcoming"}
        >
          <Stack gap="sm">
            <StepLink href="https://appstoreconnect.apple.com/access/integrations/api" />
            <StepNote>
              Users and Access → Integrations → Keys → generate a key (Developer
              access). Download the .p8 once; copy the Key ID and Issuer ID.
            </StepNote>
          </Stack>
        </Step>

        <Step
          title="Enter API key"
          state={apiKeyDone ? "done" : certDone ? "active" : "upcoming"}
        >
          <Stack gap="sm">
            {apiKeyDone ? (
              <StepDone>API key configured</StepDone>
            ) : (
              <>
                <input
                  type="file"
                  accept=".p8"
                  onChange={(e) => void handleP8File(e.target.files?.[0])}
                  className="text-caption"
                />
                {p8FileName ? (
                  <StepNote>
                    Selected: <span className="font-mono">{p8FileName}</span>
                  </StepNote>
                ) : null}
                <Input
                  placeholder="Key ID"
                  value={keyId}
                  onChange={(e) => setKeyId(e.target.value)}
                />
                <Input
                  placeholder="Issuer ID"
                  value={issuerId}
                  onChange={(e) => setIssuerId(e.target.value)}
                />
                <Button
                  variant="default"
                  loading={savingKey}
                  disabled={!p8Pem && !keyId && !issuerId}
                  onClick={handleSaveApiKey}
                >
                  Save API key
                </Button>
                <StepNote>Stored encrypted on this machine.</StepNote>
              </>
            )}
          </Stack>
        </Step>

        <Step title="Ready to sign" state={allDone ? "done" : "upcoming"}>
          <StepNote>
            The next Desktop (Tauri) release will be signed &amp; notarized.
          </StepNote>
        </Step>
      </Steps>
    </Stack>
  );
}
