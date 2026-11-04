import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "spawn-safety/no-raw-bun-spawn",
    paths: ["check/internal/fd-double-close-probe.ts"],
    kind: "sanctioned",
    reason:
      "The `bun-runtime` check's probe. It is the one file whose PURPOSE is an extra stdio pipe: it proves the running Bun does not close a finished child's extra fds a second time (oven-sh/bun#33828), which it cannot do without handing a child one. Temp-file capture would remove the very thing under test. It spawns `/bin/sh -c 'printf hi >&3'`, which exits immediately, so the wedge this rule guards has no room to happen.",
  },
  {
    rule: "owned-fd/no-raw-fd-close",
    paths: ["check/internal/fd-double-close-probe.ts"],
    kind: "sanctioned",
    reason:
      "The probe imports nothing on purpose (it probes the runtime alone, and runs under any bun binary by hand), and closing the raw fd number Bun handed it is the very act under test: it frees the number a live socket then takes, to see whether Bun closes it a second time.",
  },
  {
    rule: "check-thread-safety/no-blocking-check-work",
    paths: ["check/internal/fd-double-close-probe.ts"],
    kind: "debt",
    task: "task-1793375830-dv7cez",
    reason:
      "Per-file synchronous work on the shared check thread (a blocking fs/process call made per item, or a direct maskSource / createSourceFile) that predates the rule; move it onto ctx.repo() / fs/promises and checks/core's maskedSource / parsedTsSource.",
  },
] satisfies Exemptions;
