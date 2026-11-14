import { Pane, defineRoute } from "@plugins/primitives/plugins/pane/web";
import { isleApp } from "@plugins/apps/plugins/isle/plugins/shell/core";
import { IsleView } from "./components/isle-view";

/**
 * Isle's index pane — what bare `/isle` shows: the island, full-surface and
 * chromeless (no pane header: the island is the whole screen).
 */
export const islePane = Pane.define({
  title: isleApp.name,
  route: defineRoute({ id: "isle", segment: "" }),
  app: isleApp,
  appIndex: true,
  component: IsleView,
});
