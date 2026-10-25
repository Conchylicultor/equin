import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DeploymentDetail } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { MessagesSection } from "./components/messages-section";
import { useMessagesAvailable } from "./internal/use-messages-available";

export default {
  description:
    "Messages section of a deployment's page, shown only when the deployment's composition ships the site-messages intake: the messages visitors sent through the site, read over SSH from the box on demand, as a DataView (received, from as a reply link, the message with its full text on open, verdict, notification state), with explicit states for every way the read can fail.",
  contributions: [
    DeploymentDetail.Section({
      id: "messages",
      label: "Messages",
      icon: symbol("mail"),
      component: MessagesSection,
      useAvailable: useMessagesAvailable,
    }),
  ],
} satisfies PluginDefinition;
