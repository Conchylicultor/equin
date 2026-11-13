import type { ReactElement } from "react";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { useSupervisorsSummary } from "../internal/reads";

/**
 * The Supervisors entry's trailing summary: how many supervisor sessions are
 * live (a green dot and the count) and how many tasks wait in every backlog.
 * Nothing until both are known; nothing to say, nothing drawn.
 */
export function SupervisorsSidebarTrail(): ReactElement | null {
  const summary = useSupervisorsSummary();
  if (summary.status !== "ready") return null;
  const { live, waiting } = summary.data;
  if (live === 0 && waiting === 0) return null;
  return (
    <>
      {live > 0 ? (
        <Inline gap="2xs" title={`${live} live supervisor sessions`}>
          <StatusDot colorClass="bg-success" />
          <Text as="span" variant="count" tone="muted">
            {live}
          </Text>
        </Inline>
      ) : null}
      {waiting > 0 ? (
        <Badge tooltip={`${waiting} tasks in backlogs`}>{waiting}</Badge>
      ) : null}
    </>
  );
}
