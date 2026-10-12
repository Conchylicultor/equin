import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "live/no-endpoint-read",
    paths: [
      "web/components/config-detail.tsx",
      "web/components/conflict-diff.tsx",
      "web/components/invalid-diff.tsx",
    ],
    kind: "debt",
    task: "task-1791560308-woqgfi",
    reason:
      "A request/response server read (useEndpoint / useEndpointResource / TanStack useQuery family / fetchEndpoint in a queryFn) not yet moved onto a liveValue or liveCollection read with useLive.",
  },
] satisfies Exemptions;
