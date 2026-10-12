import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "ids:pk-declared",
    paths: ["server/internal/tables.ts"],
    kind: "debt",
    task: "task-1791405297096-jyzsmk",
    reason:
      "Phase-1 baseline of the unified prefixed ids: this table's `id` primary key names no id kind yet. Declare the kind (`defineIdKind`) and key the table with `idColumn` / `idKindField` (or `externalIdColumn` for an id minted elsewhere) in its migration phase, then delete this entry.",
  },
  {
    rule: "live/no-endpoint-read",
    paths: ["web/internal/use-saved-themes.ts"],
    kind: "debt",
    task: "task-1791560308-woqgfi",
    reason:
      "A request/response server read (useEndpoint / useEndpointResource / TanStack useQuery family / fetchEndpoint in a queryFn) not yet moved onto a liveValue or liveCollection read with useLive.",
  },
  {
    rule: "live/no-endpoint-read",
    paths: ["web/use-edit-theme.ts"],
    kind: "debt",
    task: "task-1791560308-woqgfi",
    reason:
      "A manual invalidateQueries / refetchQueries over an endpoint read's query key — refreshing a request/response read by hand — not yet replaced by a liveValue or liveCollection read with useLive.",
  },
] satisfies Exemptions;
