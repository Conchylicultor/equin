import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SiteLive } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/site-row/web";
import {
  DeployingSection,
  SiteDeployAction,
  SiteDeployActionExhibit,
} from "./components/site-live";

export default {
  description:
    "remote-deploy in the health report's deployed-site row: the deploy in progress in its body (the update's legs — done, running, upcoming — over a progress bar) and its footer's primary action when there is a next step — Restart site (the restart verb: the service restarted behind the ship's health gate, a recorded run; Restarting… while it runs) while the server answers but equin does not, else Deploy (main ahead, or a release too old for the link), labelled as the site page's button (deployLabelOf) and blocked, with the reason, while the connection to the box is lost or the server's own gate says so. Its own plugin because the row's health value (box-link/link) reads remote-deploy's running commit.",
  contributions: [
    SiteLive.Section({ id: "deploying", component: DeployingSection }),
    SiteLive.Action({
      id: "deploy",
      component: SiteDeployAction,
      exhibit: SiteDeployActionExhibit,
    }),
  ],
} satisfies PluginDefinition;
