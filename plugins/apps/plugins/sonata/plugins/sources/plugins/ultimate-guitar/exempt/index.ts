import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "ids:pk-declared",
    paths: ["server/internal/tables-tab-saved.ts"],
    kind: "debt",
    task: "task-1791405297096-jyzsmk",
    reason:
      "A trigger table built by infra/events' defineTriggerEvent, whose shared column set (events/server/internal/base-columns.ts) keys every *_triggers table by a bare uuid. Phase 6 of the unified prefixed ids keys them all at once (uuid -> text + a declared kind) in that one file; delete this entry then.",
  },
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/components/ug-import-dialog.tsx", "web/loader.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — ug-import-dialog.tsx: UgImportDialog (unsupported syntax: Handle TryStatement without a catch clause); loader.tsx: UltimateGuitarLoader (unsupported syntax: Handle TryStatement with a finalizer ('finally') clause).",
  },
] satisfies Exemptions;
