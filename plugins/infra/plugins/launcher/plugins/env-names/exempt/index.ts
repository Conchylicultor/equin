import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "user-path/no-unproven-claim",
    paths: ["core/internal/env.ts"],
    kind: "sanctioned",
    reason:
      "readEnvPath: the app's own declared env vars naming a path (the data root, a dist, a release's vendored tree) are set by the launcher or release bundle that starts the process — app-owned by that claim, made once here for every reader.",
  },
] satisfies Exemptions;
