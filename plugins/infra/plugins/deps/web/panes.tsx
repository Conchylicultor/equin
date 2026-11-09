import {
  Pane,
  PaneChrome,
  defineRoute,
} from "@plugins/primitives/plugins/pane/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { DependenciesView } from "./components/dependencies-view";

export const dependenciesRoute = defineRoute({
  id: "dependencies",
  segment: "dependencies",
});

export const dependenciesPane = Pane.define({
  title: "Dependencies",
  route: dependenciesRoute,
  app: debugApp,
  component: DependenciesBody,
  chrome: { history: true },
});

function DependenciesBody() {
  return (
    <PaneChrome pane={dependenciesPane}>
      <DependenciesView />
    </PaneChrome>
  );
}
