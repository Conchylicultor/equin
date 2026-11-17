import { defineConfig } from "@plugins/config_v2/core";
import { secretField } from "@plugins/fields/plugins/secret/plugins/config/core";

export const googleAuthConfig = defineConfig({
  name: "auth-google",
  fields: {
    clientId: secretField({
      label: "OAuth Client ID",
      description:
        "Desktop-app client ID from Google Cloud Console. Add the redirect URI the Google setup in Settings → Accounts shows (it names this account's gateway port) as the Authorized redirect URI.",
    }),
    clientSecret: secretField({
      label: "OAuth Client Secret",
      description:
        "Desktop-app client secret from Google Cloud Console. Required by Google's token endpoint even with PKCE.",
    }),
  },
});
