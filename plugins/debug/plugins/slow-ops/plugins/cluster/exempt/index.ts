import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/scan-served.ts"],
    kind: "sanctioned",
    reason:
      "debug.slow-ops.cluster.scan's truth is other fork DBs' slow_ops, which no change feed of this backend sees. Its loader reads only the in-memory scan; the one read of this backend's Postgres is `listAttempts` inside the scan its `whileSubscribed` starts, choosing which forks count as live AT the question's instant `at` — a snapshot frozen by design (Refresh is a new question), so no write to `attempts` may move a scan already asked. The lexical scan of the serveValue call reaches it through whileSubscribed.",
  },
] satisfies Exemptions;
