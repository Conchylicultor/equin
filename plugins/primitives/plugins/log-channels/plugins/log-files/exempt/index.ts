import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/channel-file.ts",
      "server/internal/client-log-family.ts",
      "server/internal/persist.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason:
      "desktop-only read path (log files on disk) for the Debug tools' server/ halves; moves to this plugin's machine/ once its last server/ importer has (split out of log-channels so the channel registry is portable)",
  },
] satisfies Exemptions;
