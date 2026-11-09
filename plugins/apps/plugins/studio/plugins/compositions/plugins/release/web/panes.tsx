import type { ReactElement } from "react";
import { Pane, PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { studioApp } from "@plugins/apps/plugins/studio/plugins/shell/core";
import { releaseDetailRoute } from "@plugins/apps/plugins/studio/plugins/compositions/plugins/release/core";
import { ReleaseDetail } from "./slots";

export const releaseDetailPane = Pane.define({
  title: "Release Run",
  // Identity (id / `rel/:runId` segment / the compositions ancestor) comes from
  // the route in `core/`, so a link built there and the pane it lands on cannot
  // drift.
  route: releaseDetailRoute,
  app: studioApp,
  component: ReleaseDetailBody,
  useResolve: false,
});

function ReleaseDetailBody(): ReactElement | null {
  const { runId } = releaseDetailPane.useParams();
  if (!runId) return null;

  return (
    <PaneChrome pane={releaseDetailPane}>
      <ReleaseDetail.Host runId={runId} />
    </PaneChrome>
  );
}
