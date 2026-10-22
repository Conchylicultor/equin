import { useState, type FormEvent, type ReactElement } from "react";
import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  getEndpointErrorMessage,
  useEndpointMutation,
} from "@plugins/infra/plugins/endpoints/web";
import { signIn } from "@plugins/auth/core";
import { useToast } from "@plugins/shell/plugins/notifications/web";

/**
 * The sign-in form of any `kind: "password"` provider, inline in its Accounts
 * pane (the `password` setup). Central trades the username + password for the
 * provider's token and keeps only the token. Signing in again over a connected
 * account replaces its token.
 */
export function PasswordSignInForm({
  providerId,
  providerName,
  usernameLabel = "Username",
  signUpUrl,
}: {
  providerId: string;
  providerName: string;
  usernameLabel?: string;
  signUpUrl?: string;
}): ReactElement {
  const toast = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // `suppressError` + an inline message: a rejection is the provider's own
  // verdict on these credentials ("There are no accounts with this username."),
  // so it belongs beside the fields, which stay filled for the retry.
  const submit = useEndpointMutation(signIn, {
    meta: { suppressError: true },
    onSuccess: ({ identity }) => {
      const who = identity.email ?? identity.displayName;
      toast({
        type: "auth",
        title: "Signed in",
        description: who ? `${providerName} (${who})` : providerName,
        variant: "success",
      });
      setUsername("");
      setPassword("");
    },
  });

  const canSubmit =
    username.trim().length > 0 && password.length > 0 && !submit.isPending;

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    if (!canSubmit) return;
    submit.mutate({
      params: { provider: providerId },
      body: { username: username.trim(), password },
    });
  }

  return (
    <Stack as="form" onSubmit={onSubmit} gap="md">
      <Text as="p" variant="caption" tone="muted">
        Your password is sent to {providerName} once, to get a sign-in token.
        Only the token is stored.
      </Text>

      <Stack as="label" gap="2xs">
        <Text variant="label">{usernameLabel}</Text>
        <Input
          name="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </Stack>

      <Stack as="label" gap="2xs">
        <Text variant="label">Password</Text>
        <Input
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Stack>

      {submit.isError && (
        <Text as="p" variant="body" tone="destructive" role="alert">
          {getEndpointErrorMessage(submit.error)}
        </Text>
      )}

      {signUpUrl && (
        <Text as="p" variant="caption" tone="muted">
          No {providerName} account?{" "}
          <a
            className="underline"
            href={signUpUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Create an account
          </a>
        </Text>
      )}

      <Stack direction="row" align="center" gap="sm">
        <Button type="submit" disabled={!canSubmit} loading={submit.isPending}>
          Sign in
        </Button>
      </Stack>
    </Stack>
  );
}
