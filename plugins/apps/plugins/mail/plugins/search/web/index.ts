import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { Mail } from "@plugins/apps/plugins/mail/plugins/shell/web";
import { mailSearchPane, mailMessagePane } from "./panes";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Mail on-demand search: a Search sidebar entry opening a query surface over the mail.search paged value (Gmail's ranked threads, reaching mail older than the sync window), drawn as a DataView of the hits' live mail.threads rows, plus a reader pane for a hit's newest matched message (its live row + its mail.message-body value).",
  contributions: [
    Mail.Sidebar({
      id: "search",
      title: "Search",
      icon: symbol("search"),
      opens: { pane: mailSearchPane, params: {} },
    }),
    Pane.Register({ pane: mailSearchPane }),
    Pane.Register({ pane: mailMessagePane }),
  ],
  slots: { "mail-search": mailSearchPane, "mail-message": mailMessagePane },
} satisfies PluginDefinition;
