import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/plugin-changes-resource.ts"],
    kind: "debt",
    task: "task-1791766351-ziteb8",
    reason:
      "Its external loader looks the conversation up in Postgres (`getConversation`, for the worktree path) before reading the plugin trees on disk, so a change to that row is invisible to it. Make the lookup an honest input (a param, or a db-served value it derives from) and drop the DB read from the external loader.",
  },
  {
    rule: "live/no-endpoint-read",
    paths: ["web/use-plugin-changes.ts"],
    kind: "debt",
    task: "task-1791560308-woqgfi",
    reason:
      "A request/response server read (useEndpoint / useEndpointResource / TanStack useQuery family / fetchEndpoint in a queryFn) not yet moved onto a liveValue or liveCollection read with useLive.",
  },
] satisfies Exemptions;
