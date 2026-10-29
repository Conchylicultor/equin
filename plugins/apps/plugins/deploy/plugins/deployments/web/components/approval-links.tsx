import type { ReactElement } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { sitePane } from "../panes";
import { DeploymentDetail } from "../slots";
import { useSetSiteTab } from "../internal/site-tab";

/** What a held run needs to name where it is resolved. */
export interface HeldRun {
  readonly deploymentId: string;
  /** `DeployRun.approvalSections` — the site page's sections to approve in. */
  readonly approvalSections: readonly string[];
}

/** The tab approval sections live in. */
const SETTINGS_TAB = "settings";

/**
 * One link per section a held run is approved in — "Open Secrets" — labelled
 * by the section's own contribution, so the run names a section by id and
 * never by its title. Each reveals its section (open + scroll into view) on the
 * site page's Settings tab: switched in place when this IS that site's page,
 * else navigated to (so ⌘/middle-click opens it in a new browser tab like any
 * link). Shared by every surface that shows a `needs-approval` run, so none
 * reads the run's message to find out where.
 */
export function ApprovalLinks({ run }: { run: HeldRun }): ReactElement | null {
  const here =
    sitePane.useRouteEntry()?.params.deploymentId === run.deploymentId;
  if (run.approvalSections.length === 0) return null;
  return here ? <LinksHere run={run} /> : <LinksElsewhere run={run} />;
}

/** On the site's own page: switch to Settings in place, then reveal. */
function LinksHere({ run }: { run: HeldRun }): ReactElement {
  const reveal = DeploymentDetail.useRevealSection();
  const setTab = useSetSiteTab();
  return (
    <LinkRow
      run={run}
      activation={(id) => () => {
        setTab(SETTINGS_TAB);
        reveal(id);
      }}
    />
  );
}

/** Anywhere else: open the site on its Settings tab, then reveal. */
function LinksElsewhere({ run }: { run: HeldRun }): ReactElement {
  const reveal = DeploymentDetail.useRevealSection();
  const openPane = useOpenPane();
  const target = openPane.to(
    sitePane,
    { deploymentId: run.deploymentId, tab: SETTINGS_TAB },
    { mode: "root" },
  );
  return (
    <LinkRow
      run={run}
      activation={(id) => ({
        open: () => {
          reveal(id);
          target.open();
        },
        href: target.href,
      })}
    />
  );
}

function LinkRow({
  run,
  activation,
}: {
  run: HeldRun;
  activation: (sectionId: string) => Activation;
}): ReactElement {
  const sections = DeploymentDetail.Section.useContributions();
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
