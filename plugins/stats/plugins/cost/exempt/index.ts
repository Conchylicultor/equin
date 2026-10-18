import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "live/no-endpoint-read",
    paths: [
      "web/components/avg-cost-per-conversation-chart.tsx",
      "web/components/cost-distribution-chart.tsx",
      "web/components/cost-kpis.tsx",
      "web/components/cumulative-cost-chart.tsx",
      "web/components/daily-cost-chart.tsx",
      "web/components/model-usage-chart.tsx",
      "web/components/token-mix-chart.tsx",
      "web/components/top-conversations-table.tsx",
    ],
    kind: "debt",
    task: "task-1791560308-woqgfi",
    reason:
      "A request/response server read (useEndpoint / useEndpointResource / TanStack useQuery family / fetchEndpoint in a queryFn) not yet moved onto a liveValue or liveCollection read with useLive.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/archive.ts",
      "server/internal/price-table.ts",
      "server/internal/usage-index.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
