import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";

import { Apps } from "@plugins/apps-core/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { mailApp } from "../core";
import { MailLayout } from "./components/mail-layout";
import { MailRailBadge } from "./components/mail-rail-badge";
import { mailRootPane } from "./panes";
import { Mail } from "./slots";

export { Mail } from "./slots";

export default {
  description:
    "App shell for Mail. Registers the /mail app entry, defines the Mail.Sidebar slot, and renders the capability-driven landing pane.",
  contributions: [
    Apps.App({
      app: mailApp,
      component: MailLayout,
      badge: MailRailBadge,
    }),
    Pane.Register({ pane: mailRootPane }),
    Core.Root({ slot: Mail.Root }),
  ],
  slots: { ...Mail, "mail-root": mailRootPane },
} satisfies PluginDefinition;
