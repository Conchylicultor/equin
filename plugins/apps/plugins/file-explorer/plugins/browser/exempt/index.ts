import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "live/no-endpoint-read",
    paths: [
      "web/components/preview-pane.tsx",
      "web/internal/folder-peek.ts",
      "web/internal/listings.ts",
    ],
    kind: "debt",
    task: "task-1791560308-woqgfi",
    reason:
      "A request/response server read (useEndpoint / useEndpointResource / TanStack useQuery family / fetchEndpoint in a queryFn) not yet moved onto a liveValue or liveCollection read with useLive.",
  },
  {
    rule: "live/no-endpoint-read",
    paths: ["web/internal/host-path-source.ts"],
    kind: "debt",
    task: "task-1791560308-woqgfi",
    reason:
      "useRootVolumeName still reads host-fs volume with useEndpoint (moves to a host-fs.volume live value in batch B5); the home directory is already read from host-account.home with useLive.",
  },
] satisfies Exemptions;
