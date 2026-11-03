import type { ReactElement } from "react";
import { ConnectButton, GrantAccessButton } from "@plugins/auth/web";
import { useSetConfig } from "@plugins/config_v2/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { gmailConfig } from "../../shared/config";
import { GMAIL_SCOPES, GOOGLE_PROVIDER_ID } from "../../core";
import { useGmailAccess } from "../internal/use-gmail-access";

/** Human copy for each unmet prerequisite, so every Gmail surface explains the
 *  same blocker the same way instead of inventing its own wording. */
export const GMAIL_BLOCKER_BODY = {
  disabled: "Gmail access is turned off. Enable it to connect your inbox.",
  disconnected: "Connect your Google account to use Mail.",
  scopes:
    "Your Google account is connected, but hasn't granted Gmail access yet.",
} as const;

/**
 * The single "fix my Gmail connection" affordance — the one place that maps an
 * unmet prerequisite to the control that actually resolves it, in situ:
 *
 * - `disabled`     → flip the Settings toggle (no navigation)
 * - `disconnected` → the Google OAuth connect popup
 * - `scopes`       → the Gmail scope-grant popup
 *
 * Consumers (Mail's landing empty-state, its sync-status banner) render this
 * rather than routing the user to Settings to work it out for themselves — and
 * they get the affordance without importing `@plugins/auth`, which this
 * integration exists to broker on their behalf.
 *
 * `reconnect` forces the grant affordance even when local state looks healthy:
 * a server-side auth failure (revoked/expired grant upstream) is invisible to
 * the browser's cached scope list, so `blocker` is null while sync is in fact
 * dead. Re-running consent is the fix in both cases.
 */
export function GmailAccessAction({
  reconnect = false,
}: {
  reconnect?: boolean;
}): ReactElement | null {
  const { blocker, loading, error, refetch } = useGmailAccess();
  const setConfig = useSetConfig(gmailConfig);

  if (loading) return null;
  // The account state could not be read: no fix can be named, so offer the
  // read's own Retry rather than a guessed control (or nothing).
  if (error !== null)
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the Google account state"
        error={error}
        refetch={refetch}
      />
    );

  switch (blocker) {
    case "disabled":
      return (
        <Button variant="outline" onClick={() => setConfig("enabled", true)}>
          Enable Gmail access
        </Button>
      );
    case "disconnected":
      return (
        <ConnectButton
          providerId={GOOGLE_PROVIDER_ID}
          scopes={[...GMAIL_SCOPES]}
          label="Connect Google"
        />
      );
    case "scopes":
      return (
        <GrantAccessButton
          providerId={GOOGLE_PROVIDER_ID}
          scopes={[...GMAIL_SCOPES]}
          label="Grant Gmail access"
        />
      );
    case null:
      return reconnect ? (
        <GrantAccessButton
          providerId={GOOGLE_PROVIDER_ID}
          scopes={[...GMAIL_SCOPES]}
          label="Reconnect Gmail"
        />
      ) : null;
  }
}
