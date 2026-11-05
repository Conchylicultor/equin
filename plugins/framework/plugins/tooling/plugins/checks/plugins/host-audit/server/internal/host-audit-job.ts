import { z } from "zod";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

const auditLog = defineLogSink({
  id: "check-host-audit",
  description:
    "Host audit log: one transcript per hourly run of the host-scoped checks on main, and the host-check reports it filed.",
});

/**
 * The owner of every host-scoped check's verdict. A host check judges state
 * shared by every checkout on the machine (the data root, the keychain), so no
 * checkout's own check pass selects it — one agent's leftover directory used to
 * turn every other agent's `./equin check` red. Its verdict lands here instead:
 * hourly, main only (a schedule's default), in main's checkout, each failing
 * check filed as a `host-check` report (`plugins/reports/plugins/host-check`).
 *
 * `--no-cache`: a host verdict is about the machine right now, and skipping the
 * cache also skips hashing main's tree. A supervised child, so the checks'
 * synchronous filesystem walks never block a backend's event loop.
 * `runAttempts: 1`: the next tick is the retry.
 */
export const hostAuditJob = defineSupervisedJob({
  name: "checks.host-audit",
  description:
    "Checks this machine's shared state (the data folder, the code-signing identity) and files a report for each problem found.",
  input: z.object({}),
  channel: auditLog,
  schedule: { cron: "23 * * * *" },
  runAttempts: 1,
  argv: () => ({
    argv: [
      `./${CLI_NAME}`,
      "check",
      "--scope",
      "host",
      "--file-reports",
      "--no-cache",
    ],
    cwd: REPO_ROOT,
  }),
});
