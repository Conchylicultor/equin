import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Mail } from "@plugins/apps/plugins/mail/plugins/shell/web";
import { GmailReconnectResume } from "./components/gmail-reconnect-resume";

export default {
  description:
    "Auto-resumes Mail sync when the Gmail scope is (re)granted: an app-wide headless listener that POSTs the sync kick endpoint on the connect edge.",
  contributions: [
    Mail.Root({ component: GmailReconnectResume, companion: true }),
  ],
} satisfies PluginDefinition;
