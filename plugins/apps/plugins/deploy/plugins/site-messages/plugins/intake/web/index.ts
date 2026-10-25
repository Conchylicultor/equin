import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { IdKinds } from "@plugins/ids/web";
import { siteMessageIdKind } from "../core";

export { useSendSiteMessage } from "./internal/use-send-site-message";

export default {
  description:
    "useSendSiteMessage() — the contact form's send (sent or rate-limited); a site takes messages by importing this barrel, which pulls the intake's server half into its composition. Registers the site-message id kind (smsg) with the web id registry — the server barrel registers the same kind.",
  contributions: [IdKinds.Kind({ kind: siteMessageIdKind })],
} satisfies PluginDefinition;
