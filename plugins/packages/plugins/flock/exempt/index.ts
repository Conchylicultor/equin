import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "spawn-safety/no-raw-bun-spawn",
    paths: ["core/internal/wait.ts"],
    kind: "sanctioned",
    reason:
      '`waitForFlock` reads "granted\\n" off the flock-wait child\'s live stdout while holding its stdin open as the release channel: the whole protocol is the open pipe, so temp-file capture is structurally impossible.',
  },
] satisfies Exemptions;
