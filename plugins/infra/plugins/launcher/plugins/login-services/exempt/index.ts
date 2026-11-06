import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "user-path/no-unproven-claim",
    paths: ["machine/internal/launchd.ts", "machine/internal/systemd.ts"],
    kind: "sanctioned",
    reason:
      "The service definition the app installs at the OS's fixed per-user location (~/Library/LaunchAgents/<label>.plist, the user systemd unit dir).",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["machine/internal/installed-label.ts"],
    kind: "debt",
    task: "task-1793970457-7rrcc4",
    reason:
      "bindInstalledLabel stats each legacy label's definition file to bind a LoginService to the label actually installed, behind the synchronous LoginServiceManager.service(id) / loginService(id) and their `.id` property — read synchronously by start / stop / root-migration, main's followMain, the gateway-drift health row, and inside login-service declarations' sync `spec()` callbacks (menu-bar's GATEWAY_LABEL env). Going async means redesigning that binding (an async service(id), or resolving the bound label once per manager and passing it into spec()).",
  },
] satisfies Exemptions;
