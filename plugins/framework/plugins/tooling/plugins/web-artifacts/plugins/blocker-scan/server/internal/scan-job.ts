import { z } from "zod";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";

const scanLog = defineLogSink({
  id: "web-artifacts-blocker-scan",
  description:
    "Blocker scan log: one run a day — the rules release, how many served URLs were checked, and every hit filed.",
});

/**
 * Daily, main only (a schedule's default): every URL main serves, checked
 * against the generic rules of the content blockers' default lists. Not part
 * of a build or `./equin check`: the rules change upstream with no commit of
 * ours, and fetching them on every build would make builds depend on GitHub.
 *
 * In a supervised child running the `web-artifacts-blocker-scan` command
 * (`../../cli`), so the walk of the served dists and the matching never block
 * a backend's event loop, and the dependency install has the CLI's
 * ExecContext. `runAttempts: 1`: the next day is the retry.
 */
export const blockerScanJob = defineSupervisedJob({
  name: "web-artifacts.blocker-scan",
  description:
    "Checks every URL main serves against the default content-blocker lists (EasyList, EasyPrivacy, uBlock filters) and reports any file they would block.",
  input: z.object({}),
  channel: scanLog,
  schedule: { cron: "41 5 * * *" },
  runAttempts: 1,
  argv: () => ({
    argv: [`./${CLI_NAME}`, "web-artifacts-blocker-scan"],
    cwd: REPO_ROOT,
  }),
});
