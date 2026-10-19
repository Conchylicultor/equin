import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Auth } from "@plugins/auth/web";
import { HOOKTHEORY_PROVIDER_ID, HOOKTHEORY_SIGN_UP_URL } from "../core";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Hooktheory Accounts row: signs in with a Hooktheory username and password through the shared sign-in form, inline in its Accounts pane.",
  contributions: [
    Auth.Provider({
      id: HOOKTHEORY_PROVIDER_ID,
      name: "Hooktheory",
      description: "TheoryTab chord progressions for songs.",
      icon: symbol("music-note"),
      setup: {
        kind: "password",
        usernameLabel: "Username",
        signUpUrl: HOOKTHEORY_SIGN_UP_URL,
      },
    }),
  ],
} satisfies PluginDefinition;
