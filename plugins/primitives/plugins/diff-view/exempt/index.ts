import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "live/no-endpoint-read",
    paths: ["web/use-file-diff.ts"],
    kind: "debt",
    task: "task-1791560308-woqgfi",
    reason:
      "A request/response server read (useEndpoint / useEndpointResource / TanStack useQuery family / fetchEndpoint in a queryFn) not yet moved onto a liveValue or liveCollection read with useLive.",
  },
  {
    rule: "live/no-endpoint-read",
    paths: ["web/components/diff-view.tsx", "web/use-diff-tokens.ts"],
    kind: "debt",
    task: "task-1791560308-woqgfi",
    reason:
      "A request/response server read (a GET fetchEndpoint or NDJSON stream an effect, a hook or a function they call runs) not yet moved onto a liveValue or liveCollection read with useLive.",
  },
] satisfies Exemptions;
