import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "user-path/no-unproven-claim",
    paths: ["machine/internal/launchd.ts", "machine/internal/systemd.ts"],
    kind: "sanctioned",
    reason:
      "The service definition the app installs at the OS's fixed per-user location (~/Library/LaunchAgents/<label>.plist, the user systemd unit dir).",
  },
] satisfies Exemptions;
