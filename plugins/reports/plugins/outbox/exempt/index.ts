import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/internal/file-report.ts", "server/internal/drain.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/writer.ts"],
    kind: "sanctioned",
    reason:
      "outboxFatalWriter, the reportOutboxFatalSink handler, writes its entry synchronously (fileReportFromProcessSync) because its caller may exit on its next statement. Only the reports engine emits that sink, from two dying or non-serving paths: its serverFatalSink handler (server-core's exitWithFatalReport, which exits next and returns never) for a process that cannot write reports, and its process-crash handler's outbox-sync lane, taken only when the process does not serve (an exec child, a CLI, a serving backend before markServerReady). A serving backend that lives on never reaches it: its crashes and reports take the crash buffer or recordReport. The async outboxWriter in the same file stays async.",
  },
] satisfies Exemptions;
