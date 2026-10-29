import type { ReactNode } from "react";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import type { Server } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import { useServerHealth } from "../hooks";

/** One line of the health checklist: a verdict dot, what was checked, and why. */
function CheckRow({
  colorClass,
  label,
  detail,
}: {
  colorClass: string;
  label: string;
  detail: ReactNode;
}) {
  return (
    <Stack direction="row" align="start" gap="sm">
      <StatusDot colorClass={colorClass} />
      <Stack gap="none">
        <Text as="span" variant="label">
          {label}
        </Text>
        <Text as="span" variant="caption" tone="muted">
          {detail}
        </Text>
      </Stack>
    </Stack>
  );
}

/**
 * What the last probe actually found, as check rows: reachable over SSH (when
 * it ran, or why it failed) and the platform it reported. The host key line the
 * pinned key would add is server-only state, so it is not a row here.
 */
export function ServerStatusSection({ server }: { server: Server }) {
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
  if (!health.found) {
    return (
      <CheckRow
        colorClass="bg-muted-foreground"
        label="Not checked yet"
        detail="Run Check now, or the SSH connection test."
      />
    );
  }
  const row = health.row;

  return (
    <Stack gap="md">
      <CheckRow
        colorClass={row.ok ? "bg-success" : "bg-destructive"}
        label={row.ok ? "Reachable over SSH" : "Not reachable over SSH"}
        detail={
          row.ok ? (
            <>
              Checked <RelativeTime date={row.checkedAt} />
            </>
          ) : (
            (row.failureMessage ?? row.failureKind ?? "The last probe failed.")
          )
        }
      />
      {row.ok && (
        <CheckRow
          colorClass={row.platform ? "bg-success" : "bg-warning"}
          label="Platform"
          detail={
            row.platform
              ? `${row.platform} · accepts ${row.platform} bundles`
              : "Unrecognized"
          }
        />
      )}
    </Stack>
  );
}
