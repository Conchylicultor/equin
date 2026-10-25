import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-raw-websocket",
    paths: ["machine/internal/relay.ts"],
    kind: "sanctioned",
    reason:
      "A backend-to-host socket, not a browser tab's: the relay dials the engine host's Unix socket (`ws+unix://`) and passes the tab's frames through — SharedWebSocket is a browser SharedWorker primitive with no Unix-socket transport.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["shared/code-id.ts"],
    kind: "sanctioned",
    reason:
      "Hashes the host's own source on disk (node:fs, node:crypto); shared because both the host (`bin/`) and the backend that decides whether to replace it (`machine/`) must compute the same id, and no barrel folder both of them may import allows platform APIs. Never imported from web/ or server/.",
  },
] satisfies Exemptions;
