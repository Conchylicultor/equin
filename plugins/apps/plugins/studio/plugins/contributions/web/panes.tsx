import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { studioApp } from "@plugins/apps/plugins/studio/plugins/shell/core";
import { ContributionsView } from "./components/contributions-view";

export const contributionsPane = Pane.define({
  title: "Contributions",
  route: defineRoute({ id: "contributions", segment: "contributions" }),
  app: studioApp,
  component: ContributionsBody,
});

function ContributionsBody() {
  return (
    <PaneChrome pane={contributionsPane}>
      <ContributionsView />
    </PaneChrome>
  );
}
