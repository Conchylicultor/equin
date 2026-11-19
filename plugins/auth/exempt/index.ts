import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "timer/no-unlisted-timer",
    paths: ["central/internal/refresh-loop.ts"],
    kind: "sanctioned",
    reason:
      "The central runtime has no job queue, so its one periodic task (refresh OAuth tokens before they expire) can only be a timer.",
  },
  {
    rule: "namespace:legacy-host",
    paths: ["central/internal/oauth-flow.test.ts"],
    kind: "sanctioned",
    reason:
      "Pins that a Connect started from main's old address posts its result back there, not to the address main is handed out under.",
  },
  {
    rule: "product-name:legacy-id",
    paths: ["central/internal/oauth-flow.test.ts"],
    kind: "sanctioned",
    reason:
      "Pins that a Connect started from main's old address posts its result back there, not to the address main is handed out under.",
  },
  {
    rule: "react-compiler:no-silent-skips",
    paths: [
      "web/components/account-detail.tsx",
      "web/components/accounts-pane.tsx",
      "web/components/connect-button.tsx",
      "web/components/grant-access-button.tsx",
      "web/components/oauth-client-setup.tsx",
      "web/components/scope-grant-notice.tsx",
    ],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — account-detail.tsx: IntegrationAccount (calls a hook carried as a value), AccountControls (unsupported syntax: Handle TryStatement with a finalizer ('finally') clause); accounts-pane.tsx: AccountsPane (calls a hook inside a function expression), AccountSummary (calls a hook carried as a value), AccountStatus (calls a hook carried as a value); connect-button.tsx: ConnectButton (unsupported syntax: Handle TryStatement with a finalizer ('finally') clause); grant-access-button.tsx: GrantAccessButton (unsupported syntax: Handle TryStatement with a finalizer ('finally') clause); oauth-client-setup.tsx: OAuthClientSetup (unsupported syntax: Handle TryStatement without a catch clause); scope-grant-notice.tsx: GatedNotice (calls a hook carried as a value).",
  },
] satisfies Exemptions;
