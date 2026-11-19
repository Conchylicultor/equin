import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { ScoreboardSection } from "./scoreboard-section";

/**
 * The scoreboard on its own (/agents/responsiveness-trend), so a supervisor's
 * page can link to it. A root pane, not a child of Stats: as a child the link
 * opened the whole Stats column beside it and drew every Stats card — this one
 * twice — for a page that asked for one.
 */
export const scoreboardPane = Pane.define({
  title: "Responsiveness trend",
  route: defineRoute({
    id: "stats-scoreboard",
    segment: "responsiveness-trend",
  }),
  app: agentManagerApp,
  component: ScoreboardPaneBody,
});

function ScoreboardPaneBody() {
  return (
    <PaneChrome pane={scoreboardPane}>
      <Inset pad="xl">
        <ScoreboardSection />
      </Inset>
    </PaneChrome>
  );
}
