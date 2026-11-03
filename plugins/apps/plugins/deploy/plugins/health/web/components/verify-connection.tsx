import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { ReactNode } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  StepDone,
  StepNote,
} from "@plugins/primitives/plugins/setup-steps/web";
import type { SshFailureKind } from "@plugins/infra/plugins/ssh/core";
import type { Server } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import {
  checkServerSsh,
  forgetServerHostKey,
  type ServerHealthRow,
  type SshCheckResult,
} from "../../shared";
import { isKeyVerified, useServerHealth } from "../hooks";

/**
 * Body of the generic last step of the SSH setup flow: opens a real SSH session
 * with the configured key and reports a *classified* verdict. Every failure
 * kind gets its own remediation — never a generic "something went wrong" —
 * because the whole point of the step is telling the user what to fix.
 *
 * Loading until the persisted verdict lands: offering "Test connection" before
 * then would present a server that passed its last check as never tested.
 */
export function VerifyConnectionBody({ server }: { server: Server }) {
  const health = useServerHealth(server.id);
  if (health.status === "loading") return <Loading />;
  if (health.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the server's last check"
        error={health.error}
        refetch={health.refetch}
      />
    );
  }
  return (
    <VerifyConnectionForm
      server={server}
      health={health.found ? health.row : null}
    />
  );
}

function VerifyConnectionForm({
  server,
  health,
}: {
  server: Server;
  /** The persisted verdict, or `null` — the server has never been checked. */
  health: ServerHealthRow | null;
}) {
  const check = useEndpointMutation(checkServerSsh);
  const forget = useEndpointMutation(forgetServerHostKey);
  const verified = isKeyVerified(health, server);

  // The mutation's own answer is the freshest truth AND the only one carrying
  // raw stderr (the durable row stores the classified kind + message, not the
  // diagnostic text); the persisted row is the fallback so a remount still
  // shows the last verdict instead of an empty step.
  const last: SshCheckResult | null = check.data ?? persistedResult(health);
  const run = () => check.mutate({ params: { id: server.id } });

  const testButton = (
    <Button
      variant={verified ? "outline" : "default"}
      loading={check.isPending}
      onClick={run}
    >
      {verified ? "Test again" : "Test connection"}
    </Button>
  );

  if (verified) {
    return (
      <Stack gap="sm" align="start">
        <StepDone>
          Connected as {server.sshUser}@{server.host}
          {health && (
            <>
              {" — checked "}
              <RelativeTime date={health.checkedAt} />
            </>
          )}
        </StepDone>
        {testButton}
      </Stack>
    );
  }

  if (last && !last.ok) {
    return (
      <Stack gap="sm" align="start">
        <Text as="p" variant="caption" className="text-destructive">
          {last.message}
        </Text>
        <StepNote>{remediation(last.kind, server)}</StepNote>
        {/* An unclassified failure is shown verbatim rather than guessed at —
            OpenSSH's own words beat a wrong summary. */}
        {last.kind === "unknown" && last.stderr && (
          <Text
            as="pre"
            variant="caption"
            className="rounded-md bg-muted px-sm py-xs font-mono whitespace-pre-wrap break-all"
          >
            {last.stderr}
          </Text>
        )}
        <Stack direction="row" gap="sm">
          {testButton}
          {last.kind === "host-key-mismatch" && (
            <Button
              variant="outline"
              loading={forget.isPending}
              onClick={() => forget.mutate({ params: { id: server.id } })}
            >
              Forget host key
            </Button>
          )}
        </Stack>
      </Stack>
    );
  }

  return (
    <Stack gap="sm" align="start">
      <StepNote>
        Opens an SSH session to {server.sshUser}@{server.host}:{server.port}{" "}
        with the configured key and reads the host&apos;s platform (
        <code>uname -sm</code>).
      </StepNote>
      {/* `last.ok` while `verified` is false means the key was replaced after
          that success — the old proof no longer says anything about this key. */}
      {last?.ok && (
        <StepNote>
          The SSH key changed since the last successful check. Test again to
          confirm the new one is installed.
        </StepNote>
      )}
      {testButton}
    </Stack>
  );
}

/** Project the durable row back onto the endpoint's result shape (no stderr). */
function persistedResult(row: ServerHealthRow | null): SshCheckResult | null {
  if (!row) return null;
  if (row.ok) return { ok: true };
  return {
    ok: false,
    kind: row.failureKind ?? "unknown",
    message: row.failureMessage ?? "The connection failed.",
    stderr: "",
  };
}

/** What the user should actually do about this failure kind. */
function remediation(kind: SshFailureKind, server: Server): ReactNode {
  switch (kind) {
    case "dns":
      return (
        <>
          The hostname <b>{server.host}</b> does not resolve. Fix the Host field
          above.
        </>
      );
    case "unreachable":
      return (
        <>
          Nothing accepted a connection on{" "}
          <b>
            {server.host}:{server.port}
          </b>
          . Check the port, and that the server is running and its firewall
          allows SSH.
        </>
      );
    case "timeout":
      return (
        <>
          The connection timed out — the host is likely down or dropping packets
          (a firewall that blackholes rather than refuses).
        </>
      );
    case "auth":
      return (
        <>
          The key isn&apos;t installed for <b>{server.sshUser}</b> yet — re-run
          the install command above, in a shell logged in as that user.
        </>
      );
    case "host-key-mismatch":
      return (
        <>
          The server presented a different host key than the one pinned on the
          first successful check. That is expected after a reinstall — and it is
          also what a man-in-the-middle looks like. Only forget the pinned key
          if you know the server was rebuilt.
        </>
      );
    case "command-failed":
      return (
        <>
          The connection and login succeeded, but the read-only check command (
          <code>uname -sm</code>) failed on the server — the account may have a
          restricted or non-interactive shell.
        </>
      );
    case "unknown":
      return <>SSH failed for a reason this app doesn&apos;t recognize:</>;
  }
}
