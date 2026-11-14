import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Isle } from "@plugins/apps/plugins/isle/plugins/buildings/web";
import { mailApp } from "@plugins/apps/plugins/mail/plugins/shell/core";
import { postOffice } from "../core";

export default {
  description:
    "Mail's building on Isle: the post office, with a dovecote whose pigeon hops and flaps.",
  contributions: [Isle.Building({ app: mailApp, building: postOffice })],
} satisfies PluginDefinition;
