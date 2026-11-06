import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "server-core/no-process-crash-listener",
    paths: ["machine/internal/boot-crash.ts"],
    kind: "sanctioned",
    reason:
      "The serving backend's boot-crash filer owns the process's crashes in the window before any processCrashSink handler attaches (a failed migration, a boot assert): installed in `register` (every boot mode runs it; it gates on serve), it stands down once isProcessCrashHandled() and is removed at ready.",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["machine/internal/own-boot-mark.ts"],
    kind: "sanctioned",
    reason:
      "Runs once from the serving entry point (server-core bin/serve.ts) before any plugin import and before the backend listens, so no request, job or timer waits on the thread; it must be synchronous so a boot killed while importing still leaves its mark.",
  },
] satisfies Exemptions;
