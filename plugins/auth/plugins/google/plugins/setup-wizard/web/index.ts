import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { GoogleSetup } from "./components/google-setup";

export default {
  description:
    "Guided setup steps for Google OAuth credentials (project → Drive API → consent screen → OAuth client → paste → connect), rendered inline in the Google Accounts pane.",
  contributions: [],
} satisfies PluginDefinition;
