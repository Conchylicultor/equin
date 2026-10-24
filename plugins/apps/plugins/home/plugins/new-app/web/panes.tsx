import { Pane } from "@plugins/primitives/plugins/pane/web";
import {
  homeApp,
  newAppRoute,
} from "@plugins/apps/plugins/home/plugins/shell/core";
import { NewAppPage } from "./components/new-app-page";

/** The New app screen, `/home/new`: full-surface, over the launcher. */
export const newAppPane = Pane.define({
  title: "New app",
  route: newAppRoute,
  app: homeApp,
  component: NewAppPage,
});
