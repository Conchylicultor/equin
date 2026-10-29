import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { Server } from "@plugins/apps/plugins/deploy/plugins/servers/web";
import { checkServerSsh } from "../../shared";
import { useServerHealth } from "../hooks";
import { ServerStatusBadge, serverStatus } from "./server-status-badge";

const refreshIcon = symbol("refresh");

/**
 * The status beside the server's name. Nothing while the verdict loads or
 * failed to read — `Unknown` would claim "never checked", which a pending read
 * cannot (the Health section renders the failure with its Retry).
 */
export function ServerHeaderStatus({ server }: { server: Server }) {
  const health = useServerHealth(server.id);
  if (health.status === "loading" || health.status === "error") return null;
  return (
    <ServerStatusBadge
      status={serverStatus(health.found ? health.row : undefined)}
    />
  );
}

/** The platform the last successful probe reported, on the header's meta line. */
export function ServerHeaderPlatform({ server }: { server: Server }) {
  const health = useServerHealth(server.id);
  if (health.status === "loading" || health.status === "error") return null;
  if (!health.found || !health.row.ok || !health.row.platform) return null;
  return (
    <Text as="span" variant="caption" tone="muted">
      · {health.row.platform}
    </Text>
  );
}

/** Re-probe the server now (the same endpoint the SSH setup's last step runs). */
export function CheckNowAction({ server }: { server: Server }) {
  const check = useEndpointMutation(checkServerSsh);
  return (
    <Button
      variant="outline"
      loading={check.isPending}
      onClick={() => check.mutate({ params: { id: server.id } })}
    >
      <Icon icon={refreshIcon} />
      Check now
    </Button>
  );
}
