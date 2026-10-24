import { Pane } from "@plugins/primitives/plugins/pane/web";
import { homeApp, homeRootRoute } from "../core";
import { HomeRoot } from "./components/home-root";

/** The launcher: Home's index pane, at bare `/home`. */
export const homeRootPane = Pane.define({
  title: "Apps",
  route: homeRootRoute,
  app: homeApp,
  appIndex: true,
  component: HomeRoot,
});
