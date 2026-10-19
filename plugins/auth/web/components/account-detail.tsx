import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState, type ReactNode } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@plugins/primitives/plugins/collapsible/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { SectionCard } from "@plugins/primitives/plugins/section-card/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import type { AuthAccountState } from "@plugins/auth/core";
import {
  Auth,
  type AuthIntegrationContribution,
  type AuthProviderContribution,
  type ProviderSetup,
} from "../slots";
import { useAuthState } from "../hooks";
import { toast } from "@plugins/shell/plugins/notifications/web";
import { currentWorktreeName, disconnect, startConnectFlow } from "../connect";
import { ScopeGrantNotice } from "./scope-grant-notice";
import { PasswordSignInForm } from "./password-sign-in-form";
import { OAuthClientSetup } from "./oauth-client-setup";
import { useProviderStatus } from "./provider-status";
import {
  IntegrationHeader,
  IntegrationStatusBadge,
} from "./integration-presentation";

/**
 * One Accounts row's pane — a provider or an integration, the same shape for
 * both: the header (what it is, its status), then, for a provider, its account
 * (who, scopes, missing grants, the last refresh failure, Disconnect), then its
 * setup, inline. There is no second pane: whatever a row needs to be set up or
 * managed is here.
 */
export function AccountDetail({ accountId }: { accountId: string }) {
  const provider = Auth.Provider.useContributions().find(
    (p) => p.id === accountId,
  );
  const integration = Auth.Integration.useContributions().find(
    (i) => i.id === accountId,
  );
  if (provider) return <ProviderAccount provider={provider} />;
  if (integration) return <IntegrationAccount integration={integration} />;
  return (
    <Text as="div" variant="body" className="p-xl text-muted-foreground">
      No installed plugin provides the account &ldquo;{accountId}&rdquo;.
    </Text>
  );
}

/** An integration's pane: the shared header over its own setup, which is also where it is managed. */
function IntegrationAccount({
  integration,
}: {
  integration: AuthIntegrationContribution;
}) {
  const status = integration.useStatus();
  const Setup = integration.setup;
  return (
    <Stack gap="xl" className="p-xl">
      <IntegrationHeader
        icon={integration.icon}
        name={integration.name}
        service={integration.service}
        description={integration.description}
        status={<IntegrationStatusBadge result={status} />}
      />
      <Setup />
    </Stack>
  );
}

function ProviderAccount({ provider }: { provider: AuthProviderContribution }) {
  // Read the whole auth state rather than `useAccountStatus`, whose `null`
  // means two things: "the state has not arrived yet" and "it arrived and
  // central has no such provider". The second is normal in an agent worktree —
  // central runs main's code, so it does not know a provider added on a branch.
  const authState = useAuthState();

  // Four states, each with its own rendering: the state has not arrived yet
  // (a skeleton, never a guessed "Disconnected"), its read failed (the error
  // block, whose button retries), central does not know the provider, or the
  // provider's account and setup.
  let body: ReactNode;
  if (authState.status === "loading") {
    body = <Loading variant="rows" count={3} />;
  } else if (authState.status === "error") {
    body = (
      <ResourceErrorInline
        variant="block"
        subject="the account state"
        error={authState.error}
        refetch={authState.refetch}
      />
    );
  } else {
    const status = authState.data.providers[provider.id];
    body = status ? (
      <>
        {status.connected ? (
          <Stack gap="md">
            <AccountDetails providerId={provider.id} status={status} />
            <Stack direction="row" gap="sm" align="center">
              <AccountControls provider={provider} status={status} />
            </Stack>
          </Stack>
        ) : null}
        {/* Open while there is nothing to manage yet; folded under the account
            once connected — the setup is still where a key is replaced or a
            sign-in redone. Uncontrolled, so finishing the setup leaves it open
            on its "done" state instead of snapping shut. */}
        <SectionCard
          title={setupTitle(provider.setup)}
          defaultOpen={!status.connected}
        >
          <ProviderSetupBody provider={provider} status={status} />
        </SectionCard>
      </>
    ) : (
      <Text as="div" variant="body" className="text-muted-foreground">
        The main app doesn&apos;t include this provider yet, so it can&apos;t be
        connected from here.
      </Text>
    );
  }

  return (
    <Stack gap="xl" className="p-xl">
      <IntegrationHeader
        icon={provider.icon}
        name={provider.name}
        service={provider.service ?? provider.name}
        description={provider.description}
        status={<ProviderStatusBadge providerId={provider.id} />}
      />
      {body}
    </Stack>
  );
}

function setupTitle(setup: ProviderSetup): string {
  switch (setup.kind) {
    case "password":
      return "Sign in";
    case "steps":
    case "oauth-client":
      return "Setup";
  }
}

/**
 * The provider's setup, one arm per `ProviderSetup` kind. A generic arm that
 * does not match central's kind for the provider is a wiring bug — the form
 * would post to an endpoint central rejects — so it throws.
 */
function ProviderSetupBody({
  provider,
  status,
}: {
  provider: AuthProviderContribution;
  status: AuthAccountState;
}) {
  const setup = provider.setup;
  switch (setup.kind) {
    case "steps": {
      const Steps = setup.component;
      return <Steps />;
    }
    case "oauth-client":
      assertKind(provider, status, "oauth2");
      return (
        <OAuthClientSetup
          providerId={provider.id}
          providerName={provider.name}
          setup={setup}
          status={status}
        />
      );
    case "password":
      assertKind(provider, status, "password");
      return (
        <PasswordSignInForm
          providerId={provider.id}
          providerName={provider.name}
          usernameLabel={setup.usernameLabel}
          signUpUrl={setup.signUpUrl}
        />
      );
  }
}

function assertKind(
  provider: AuthProviderContribution,
  status: AuthAccountState,
  kind: AuthAccountState["kind"],
): void {
  if (status.kind !== kind) {
    throw new Error(
      `auth: provider "${provider.id}" declares a "${provider.setup.kind}" setup, which needs a "${kind}" provider, but central registers it as "${status.kind}".`,
    );
  }
}

function ProviderStatusBadge({ providerId }: { providerId: string }) {
  return <IntegrationStatusBadge result={useProviderStatus(providerId)} />;
}

/**
 * A connected account's buttons — one arm per kind. Connecting, and replacing a
 * key or a sign-in, is the setup's job; what is left is reconsenting an OAuth
 * grant and disconnecting.
 *
 * Two limits of api-key and password accounts are real and deliberate, not
 * oversights:
 *  - such an account reads `connected: true` from the moment its credential is
 *    stored, and nothing ever marks it stale — the refresh loop only walks
 *    oauth2 providers. A key or token revoked upstream still shows Connected
 *    until a call using it fails.
 *  - Disconnect deletes the local entry only; it does not revoke the
 *    credential at the provider.
 */
function AccountControls({
  provider,
  status,
}: {
  provider: AuthProviderContribution;
  status: AuthAccountState;
}) {
  const providerId = provider.id;
  const [busy, setBusy] = useState(false);

  async function handleReconnect() {
    setBusy(true);
    try {
      const result = await startConnectFlow({
        providerId,
        worktree: currentWorktreeName(),
      });
      if (result.ok) {
        toast({
          type: "auth",
          title: "Connected",
          description: `${provider.name}${
            result.identity?.email ? ` (${result.identity.email})` : ""
          }`,
          variant: "success",
        });
      } else if (result.message && result.message !== "cancelled") {
        toast({
          type: "auth",
          title: `Failed to connect ${provider.name}`,
          description: result.message,
          variant: "error",
        });
      }
    } catch (err) {
      toast({
        type: "auth",
        title: `Failed to connect ${provider.name}`,
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    try {
      await disconnect(providerId);
      toast({
        type: "auth",
        title: "Disconnected",
        description: provider.name,
        variant: "success",
      });
    } catch (err) {
      toast({
        type: "auth",
        title: "Disconnect failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  const disconnectButton = (
    <Button variant="outline" loading={busy} onClick={handleDisconnect}>
      Disconnect
    </Button>
  );

  // Exhaustive on the kind: a new kind is a type error here.
  switch (status.kind) {
    case "apikey":
    case "password":
      return disconnectButton;
    case "oauth2":
      return (
        <>
          {status.needsReconsent ? (
            <Button variant="default" loading={busy} onClick={handleReconnect}>
              Reconnect
            </Button>
          ) : null}
          {disconnectButton}
        </>
      );
    default: {
      const unknownKind: never = status.kind;
      throw new Error(`auth: unhandled provider kind "${String(unknownKind)}"`);
    }
  }
}

/** Who is connected, which scopes were granted, and the last refresh failure. */
function AccountDetails({
  providerId,
  status,
}: {
  providerId: string;
  status: AuthAccountState;
}) {
  const who = status.identity?.email ?? status.identity?.displayName;

  return (
    <>
      {who ? (
        <Text as="div" variant="body" className="truncate">
          {/* An api key has no user behind it — its identity names the
              service the key opens ("Google Maps Platform"). */}
          {status.kind === "apikey" ? "Key for" : "Signed in as"}{" "}
          <span className="font-medium">{who}</span>
        </Text>
      ) : null}
      {status.scopes && status.scopes.length > 0 ? (
        <Collapsible className="text-caption text-muted-foreground">
          <CollapsibleTrigger className="gap-2xs">
            <CollapsibleChevron className="size-3" />
            {status.scopes.length} scope
            {status.scopes.length === 1 ? "" : "s"}
          </CollapsibleTrigger>
          {/* eslint-disable-next-line spacing/no-adhoc-spacing -- list offset below summary, inside the fold so it tweens with it */}
          <CollapsibleContent className="pt-1">
            {/* eslint-disable-next-line spacing/no-adhoc-spacing -- indent for nested list */}
            <ul className="list-disc pl-4">
              {status.scopes.map((s) => (
                <li key={s} className="break-all">
                  {s}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      {status.credentialsConfigured ? (
        <ScopeGrantNotice providerId={providerId} status={status} />
      ) : null}
      {status.lastRefreshError ? (
        <Text as="div" variant="caption" className="text-warning">
          Last refresh failed:{" "}
          <span className="font-mono">{status.lastRefreshError.message}</span>
        </Text>
      ) : null}
    </>
  );
}
