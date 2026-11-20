import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "web-locks/no-raw-navigator-locks",
    paths: ["web/stall-watchdog.worker.ts"],
    kind: "sanctioned",
    reason:
      "The watchdog SharedWorker is bundled whole and may import no other plugin, so it cannot reach webLocks(). It is started only by a tab whose webLocks() is supported (tab-watch.ts), and fails loudly if its own context has none.",
  },
] satisfies Exemptions;
