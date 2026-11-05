import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "server-core/no-process-crash-listener",
    paths: ["machine/internal/boot-crash.ts"],
    kind: "sanctioned",
    reason:
      "The serving backend's boot-crash filer owns the process's crashes in the window before any processCrashSink handler attaches (a failed migration, a boot assert): installed in `register` (every boot mode runs it; it gates on serve), it stands down once isProcessCrashHandled() and is removed at ready.",
  },
] satisfies Exemptions;
