import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  DeploymentItemActions,
  SiteHeader,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { ServeAction } from "./components/serve-action";
import { ServeHeaderAction } from "./components/serve-header-action";

export default {
  description:
    "Test locally: the site page's header button that serves the site's composition on the shared gateway (opening it once live), plus the same one-button serve/open shortcut on the deployments list row.",
  contributions: [
    SiteHeader.Action({ id: "serve", component: ServeHeaderAction }),
    DeploymentItemActions({ id: "serve", component: ServeAction }),
  ],
} satisfies PluginDefinition;
