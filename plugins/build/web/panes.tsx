import type { ReactElement } from "react";
import { Pane, PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { buildRoute, buildDetailRoute } from "@plugins/build/core";
import { BuildPopoverContent } from "./components/build-popover-content";
import { BuildDetail } from "./slots";

export const buildPane = Pane.define({
  title: "Builds",
  route: buildRoute,
  app: debugApp,
  component: BuildPaneBody,
});

export const buildDetailPane = Pane.define({
  title: "Build Run",
  route: buildDetailRoute,
  app: debugApp,
  component: BuildDetailBody,
  width: 480,
  useResolve: false,
});

function BuildPaneBody(): ReactElement {
  // No `onRunClick`: a row's destination belongs to the arm that owns the row —
  // the build arm's `runLinks` pushes `buildDetailPane` from whichever
  // surface the row was clicked in, and a backup row goes somewhere else
  // entirely. `selectedRunId` stays, because which row is OPEN is this pane's
  // own knowledge and nothing else can supply it.
  const selectedRunId = buildDetailPane.useRouteEntry()?.params.runId;

  return (
    <PaneChrome pane={buildPane}>
      <BuildPopoverContent variant="pane" selectedRunId={selectedRunId} />
    </PaneChrome>
  );
}

function BuildDetailBody(): ReactElement {
  const { runId } = buildDetailPane.useParams();

  return (
    <PaneChrome pane={buildDetailPane}>
      <BuildDetail.Host runId={runId} />
    </PaneChrome>
  );
}
