import type { ReactElement } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { deploymentDetailPane } from "../panes";
import { DeploymentDetail } from "../slots";

/** What a held run needs to name where it is resolved. */
export interface HeldRun {
  readonly deploymentId: string;
  readonly serverId: string;
  /** `DeployRun.approvalSections` — the deployment-pane sections to approve in. */
  readonly approvalSections: readonly string[];
}

/**
 * Where a held run's approval section is: an activation that reveals it (open +
 * scroll into view) and, when this is not already the deployment's pane, a
 * link to that pane — so ⌘/middle-click opens it in a new browser tab like any
 * link. Shared by every surface that shows a `needs-approval` run, so each
 * links the same way and none reads the run's message to find out where.
 */
function useApprovalActivation(
  run: HeldRun,
): (sectionId: string) => Activation {
  const reveal = DeploymentDetail.useRevealSection();
  const openPane = useOpenPane();
  const here =
    deploymentDetailPane.useRouteEntry()?.params.deploymentId ===
    run.deploymentId;
  return (sectionId) => {
    if (here) return () => reveal(sectionId);
    const target = openPane.to(
      deploymentDetailPane,
      { serverId: run.serverId, deploymentId: run.deploymentId },
      { mode: "push", side: "right" },
    );
    return {
      open: () => {
        reveal(sectionId);
        target.open();
      },
      href: target.href,
    };
  };
}

/**
 * One link per section a held run is approved in — "Open Secrets" — labelled
 * by the section's own contribution, so the run names a section by id and
 * never by its title.
 */
export function ApprovalLinks({ run }: { run: HeldRun }): ReactElement | null {
  const sections = DeploymentDetail.Section.useContributions();
  const activation = useApprovalActivation(run);
  if (run.approvalSections.length === 0) return null;
  return (
    <Cluster gap="sm">
      {run.approvalSections.map((id) => (
        <Button
          key={id}
          variant="link"
          {...activationProps(activation(id), { isolate: true })}
        >
          Open {sections.find((s) => s.id === id)?.label ?? id}
        </Button>
      ))}
    </Cluster>
  );
}
