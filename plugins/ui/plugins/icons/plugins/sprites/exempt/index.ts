import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "live/no-endpoint-read",
    paths: ["web/internal/sprite-host.tsx"],
    kind: "debt",
    task: "task-1791560308-woqgfi",
    reason:
      "A request/response server read (a GET fetchEndpoint or NDJSON stream an effect, a hook or a function they call runs) not yet moved onto a liveValue or liveCollection read with useLive.",
  },
  {
    rule: "networking/no-page-transport",
    paths: ["web/internal/sprite-host.tsx"],
    kind: "sanctioned",
    reason:
      "The page's icon sprites are page chrome, loaded once per page from the page's own server.",
  },
] satisfies Exemptions;
