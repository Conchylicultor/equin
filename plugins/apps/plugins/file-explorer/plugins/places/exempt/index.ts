import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "live/no-endpoint-read",
    paths: ["web/components/storage-meter.tsx"],
    kind: "debt",
    task: "task-1791560308-woqgfi",
    reason:
      "A request/response server read (useEndpoint / useEndpointResource / TanStack useQuery family / fetchEndpoint in a queryFn) not yet moved onto a liveValue or liveCollection read with useLive.",
  },
  {
    rule: "live/no-endpoint-read",
    paths: ["web/internal/places.ts"],
    kind: "debt",
    task: "task-1791560308-woqgfi",
    reason:
      "The startup-volume place still reads host-fs volume with useEndpoint (moves to a host-fs.volume live value in batch B5); the main-checkout read is already on useLive.",
  },
] satisfies Exemptions;
