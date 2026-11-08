import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "networking/no-page-transport",
    paths: ["web/report.ts"],
    kind: "sanctioned",
    reason:
      "Page-wide telemetry: report() files window.onerror, boot and crash-beacon reports, which belong to the page and always reach the page's own server (D3).",
  },
  {
    rule: "investigate:failures-registered",
    paths: ["core/resources.ts"],
    kind: "sanctioned",
    reason:
      "A regressed report (`fixState`, tinted destructive) IS a failure to act on, and reports carry their own investigation: the Fix action on every report notification and the detail pane's Investigate (`investigateReport`), whose task is linked on the row (`reports.task_id`) and drives the worklist. The generic Investigate would file a second, unlinked task about the same report.",
  },
] satisfies Exemptions;
