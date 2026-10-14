import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import type { ServerHealthRow } from "../../shared";

export type ServerStatus = "unknown" | "online" | "offline";

/**
 * The one derivation of a server's status, from the one fact that decides it —
 * the last probe's `ok`: no probe row (`null`) → never checked (`unknown`), a
 * successful probe → `online`, anything else → `offline`.
 */
export function statusOfOk(ok: boolean | null): ServerStatus {
  if (ok === null) return "unknown";
  return ok ? "online" : "offline";
}

/** {@link statusOfOk} of a probe row (`undefined`: never probed). */
export function serverStatus(row: ServerHealthRow | undefined): ServerStatus {
  return statusOfOk(row ? row.ok : null);
}

const styles: Record<ServerStatus, { bg: string; label: string }> = {
  online: { bg: "bg-success", label: "Online" },
  offline: { bg: "bg-destructive", label: "Offline" },
  unknown: { bg: "bg-muted-foreground", label: "Unknown" },
};

export function ServerStatusBadge({ status }: { status: ServerStatus }) {
  const { bg, label } = styles[status];
  return (
    <Stack as="span" direction="row" align="center" gap="xs">
      <StatusDot colorClass={bg} className="inline-block" />
      <Text as="span" variant="caption">
        {label}
      </Text>
    </Stack>
  );
}
