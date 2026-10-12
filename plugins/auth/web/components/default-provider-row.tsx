import { Icon } from "@plugins/ui/plugins/icons/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Button, cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState, type ReactNode } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import type { AuthAccountState } from "@plugins/auth/core";
import { Auth, type AuthProviderContribution } from "../slots";
import { useAuthState } from "../hooks";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { toast } from "@plugins/shell/plugins/notifications/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { configNavPane } from "@plugins/config_v2/plugins/settings/web";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { currentWorktreeName, disconnect, startConnectFlow } from "../connect";
import { ScopeGrantNotice } from "./scope-grant-notice";
import { PasswordSignInDialog } from "./password-sign-in-dialog";

interface Props {
  providerId: string;
}

export function DefaultProviderRow({ providerId }: Props) {
  // Read the whole auth state rather than `useAccountStatus`, whose `null`
  // means two things: "the state has not arrived yet" and "it arrived and
  // central has no such provider". The second is normal in an agent worktree —
  // central runs main's code, so it does not know a provider added on a branch.
  const authState = useAuthState();
  const providers = Auth.Provider.useContributions();
  const provider = providers.find((p) => p.id === providerId);

  if (!provider) return null;
  const icon = provider.icon;

  // Four states, each with its own rendering: the state has not arrived yet
  // (a spinner, never a guessed "Disconnected"), its read failed (the error
  // control, whose click retries), central does not know the provider, or the
  // provider's account state.
  let pill: ReactNode = null;
  let details: ReactNode = null;
  let controls: ReactNode;
  if (authState.status === "loading") {
    controls = <Loading variant="spinner" />;
  } else if (authState.status === "error") {
    controls = (
      <ResourceErrorInline
        variant="icon"
        subject="the account state"
        error={authState.error}
        refetch={authState.refetch}
      />
    );
  } else {
    const status = authState.data.providers[providerId];
    if (status) {
      pill = <StatusPill status={status} />;
      details = <AccountDetails providerId={providerId} status={status} />;
      controls = <AccountControls provider={provider} status={status} />;
    } else {
      pill = <Badge variant="muted">Unavailable</Badge>;
      details = (
        <Text as="div" variant="body" className="text-muted-foreground">
          The main app doesn&apos;t include this provider yet, so it can&apos;t
          be connected from here.
        </Text>
      );
      controls = null;
    }
  }

  return (
    <Stack direction="row" gap="lg" align="start" className="p-lg">
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- top offset to baseline-align icon with adjacent text */}
      <Icon icon={icon} className={cn("mt-1 h-6 w-6", rigidClass())} />
      <Fill>
        <Stack direction="row" align="center" gap="sm">
          <span className="font-medium">{provider.name}</span>
          {pill}
        </Stack>
        {details}
      </Fill>
      <Stack direction="row" gap="sm" align="center" className={rigidClass()}>
        {controls}
      </Stack>
    </Stack>
  );
}

/** The row's buttons for a provider central knows — one arm per kind. */
function AccountControls({
  provider,
  status,
}: {
  provider: AuthProviderContribution;
  status: AuthAccountState;
}) {
  const providerId = provider.id;
  const [busy, setBusy] = useState(false);
  const openPane = useOpenPane();

  async function handleConnect() {
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

  const credentialsMissing = !status.credentialsConfigured;
  const needsReconsent = status.needsReconsent;
  const connected = status.connected;

  // An api-key or password provider has no OAuth popup to open:
  // `handleOAuthStart` rejects a non-oauth2 provider with a 400, so
  // `startConnectFlow` must never be reached for one. An api-key provider's one
  // action is "give me the key", which is whatever the provider registered as
  // `credentialsPane` (normally a setup pane); a password provider's is
  // the sign-in dialog, whose exchange stores only the returned token.
  //
  // Two limits are real and deliberate, not oversights:
  //  - such an account reads `connected: true` from the moment its credential
  //    is stored, and nothing ever marks it stale — the refresh loop only walks
  //    oauth2 providers. A key or token revoked upstream still shows Connected
  //    until a call using it fails.
  //  - Disconnect deletes the local entry only; it does not revoke the
  //    credential at the provider.
  const credentialSetup = activationProps(
    provider.credentialsPane
      ? openPane.to(provider.credentialsPane, {}, { mode: "root" })
      : openPane.to(configNavPane, {}, { mode: "push" }),
  );

  function openSignIn() {
    void openDialog(
      (close) => (
        <PasswordSignInDialog
          providerId={providerId}
          providerName={provider.name}
          usernameLabel={provider.passwordSignIn?.usernameLabel}
          signUpUrl={provider.passwordSignIn?.signUpUrl}
          close={close}
        />
      ),
      // Not dismissible by an outside press: the user is part-way through typing
      // a username and password, and a stray click would discard both silently.
      { size: "sm", dismissible: false },
    );
  }

  // Exhaustive on the kind: a new kind is a type error here, never a silent
  // fall into the OAuth arm (whose popup central would reject).
  function renderControls(): ReactNode {
    switch (status.kind) {
      case "apikey":
        return (
          <>
            <Button
              variant={connected ? "outline" : "default"}
              {...credentialSetup}
            >
              {connected ? "Replace key" : "Add key"}
            </Button>
            {connected ? (
              <Button
                variant="outline"
                loading={busy}
                onClick={handleDisconnect}
              >
                Disconnect
              </Button>
            ) : null}
          </>
        );
      case "password":
        return connected ? (
          <>
            <Button variant="outline" onClick={openSignIn}>
              Sign in again
            </Button>
            <Button variant="outline" loading={busy} onClick={handleDisconnect}>
              Disconnect
            </Button>
          </>
        ) : (
          <Button variant="default" onClick={openSignIn}>
            Sign in
          </Button>
        );
      case "oauth2":
        if (credentialsMissing) {
          return (
            <Button variant="outline" {...credentialSetup}>
              Configure credentials
            </Button>
          );
        }
        return connected ? (
          <>
            {needsReconsent ? (
              <Button variant="default" loading={busy} onClick={handleConnect}>
                Reconnect
              </Button>
            ) : null}
            <Button variant="outline" loading={busy} onClick={handleDisconnect}>
              Disconnect
            </Button>
          </>
        ) : (
          <Button variant="default" loading={busy} onClick={handleConnect}>
            Connect
          </Button>
        );
      default: {
        const unknownKind: never = status.kind;
        throw new Error(
          `auth: unhandled provider kind "${String(unknownKind)}"`,
        );
      }
    }
  }

  return renderControls();
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
        <Text
          as="div"
          variant="body"
          className="text-muted-foreground truncate"
        >
          {who}
        </Text>
      ) : null}
      {status.scopes && status.scopes.length > 0 ? (
        // eslint-disable-next-line spacing/no-adhoc-spacing -- vertical offset from preceding sibling block
        <details className="mt-1 text-caption text-muted-foreground">
          <summary>
            {status.scopes.length} scope
            {status.scopes.length === 1 ? "" : "s"}
          </summary>
          {/* eslint-disable-next-line spacing/no-adhoc-spacing -- list offset below summary + indent for nested list */}
          <ul className="mt-1 list-disc pl-4">
            {status.scopes.map((s) => (
              <li key={s} className="break-all">
                {s}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {status.connected && status.credentialsConfigured ? (
        <ScopeGrantNotice providerId={providerId} status={status} />
      ) : null}
      {status.lastRefreshError ? (
        // eslint-disable-next-line spacing/no-adhoc-spacing -- vertical offset from preceding sibling block
        <Text as="div" variant="caption" className="mt-1 text-warning">
          Last refresh failed:{" "}
          <span className="font-mono">{status.lastRefreshError.message}</span>
        </Text>
      ) : null}
    </>
  );
}

function StatusPill({ status }: { status: AuthAccountState }) {
  switch (status.kind) {
    case "apikey":
      // `credentialsConfigured` is hardcoded `true` for every non-oauth2 provider
      // (auth/central/internal/auth-state.ts), so "Setup required" can never fire
      // here. Whether a key has been stored is the only real signal.
      return status.connected ? (
        <Badge variant="success">Connected</Badge>
      ) : (
        <Badge variant="muted">Not set up</Badge>
      );
    case "password":
      // Same single signal as an api key: whether a sign-in token is stored.
      return status.connected ? (
        <Badge variant="success">Connected</Badge>
      ) : (
        <Badge variant="muted">Not signed in</Badge>
      );
    case "oauth2":
      if (!status.credentialsConfigured) {
        return <Badge variant="muted">Setup required</Badge>;
      }
      if (status.needsReconsent) {
        return <Badge variant="warning">Needs reconsent</Badge>;
      }
      if (status.connected) {
        return <Badge variant="success">Connected</Badge>;
      }
      return <Badge variant="muted">Disconnected</Badge>;
    default: {
      const unknownKind: never = status.kind;
      throw new Error(`auth: unhandled provider kind "${String(unknownKind)}"`);
    }
  }
}
