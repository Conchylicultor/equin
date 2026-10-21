import { z } from "zod";
import { repoProgram } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  TYPE_CHECK_DIVERGENCE_KIND,
  TYPE_CHECK_WORKER_UNITS,
  type TypeCheckWorkerResult,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/core";
import { spawnTypeCheckWorker } from "@plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/server";
import type { Grant } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import {
  inheritedGrant,
  withHostGrant,
} from "@plugins/infra/plugins/host/plugins/host-admission/server";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/core";

const backstopLog = defineLogSink({
  id: "type-check-backstop",
  description:
    "Type-check backstop ops log: the daily dual run on main (the two-program check beside a full check) and its divergences.",
});

// Reports filed per run. A divergence is a key bug, so one is enough to act on;
// a hundred are the same bug seen a hundred times, and every one is logged.
const MAX_REPORTS = 20;

// A wedge-breaker for one metadata read, not a latency budget.
const GIT_TIMEOUT_MS = 30_000;

/**
 * The two-program type check's BACKSTOP. A check run re-checks only the files
 * whose key moved — and what their changed names reach — and trusts the store
 * for the rest (type-check's `shared/name-run.ts`), so nothing in it would
 * notice a key or an affected set that misses something a file's check reads.
 * Once a day, on main, this runs the worker in `dual` mode: the two-program
 * check, then a full check of a fresh whole program, compared file by file.
 * Every divergence is logged and filed as a `type-check-divergence` report, and
 * on any divergence a cold run rewrites the store, so the next run on any
 * worktree reads the right answer.
 *
 * In a supervised child (`./singularity supervised-exec`), so a restart does
 * not kill it part-way and no job slot is held for its minutes. Admitted like
 * any worker: a grant (inherited, or a background one of its own), then
 * `spawnTypeCheckWorker`'s host-wide slot. Not part of any build.
 *
 * `runAttempts: 1`: the next daily tick is the retry.
 */
export const typeCheckBackstopJob = defineSupervisedJob({
  name: "type-check.backstop",
  description:
    "Runs the two-program type check beside a full check on main and reports any file where they disagree.",
  input: z.object({}),
  channel: backstopLog,
  schedule: { cron: "30 4 * * *" }, // daily at 04:30 UTC; main only
  runAttempts: 1,
  async run(_input, { log }) {
    const root = await getWorktreeRoot();
    const rev = await spawnCaptured(["git", "rev-parse", "HEAD"], {
      cwd: root,
      env: process.env,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (rev.exitCode !== 0) {
      throw new Error(
        `type-check backstop: git rev-parse HEAD exited ${rev.exitCode}`,
      );
    }
    const head = rev.stdout.trim();
    const program = repoProgram(root);
    const spawn = async (grant: Grant): Promise<TypeCheckWorkerResult> =>
      (
        await spawnTypeCheckWorker({
          root,
          name: program.name,
          tsconfigPath: program.tsconfigPath,
          tscMode: "dual",
          onMiss: "throw",
          lintFiles: [],
          grant,
        })
      ).result;
    const inherited = inheritedGrant();
    const result = inherited
      ? await spawn(inherited)
      : await withHostGrant(
          {
            lane: "background",
            priority: "normal",
            max: TYPE_CHECK_WORKER_UNITS,
          },
          spawn,
        );
    for (const line of result.tscLines) log(line);
    const { check, full } = result.phaseCpuSeconds;
    log(
      `backstop at ${head}: cpu two-program check ${check.toFixed(1)}s, full ${full.toFixed(1)}s; ${result.divergences.length} divergences`,
    );

    const unfiled: string[] = [];
    for (const [i, d] of result.divergences.entries()) {
      log(`DIVERGES ${d.kind} ${d.file}`, "stderr");
      if (i >= MAX_REPORTS) continue;
      // Through the OUTBOX: this body runs in the supervised child, not the
      // serving backend, which is the only process that may record a report.
      const filed = await fileReportFromProcess({
        kind: TYPE_CHECK_DIVERGENCE_KIND,
        message: `two-program type check diverged on ${d.file} (${d.kind})`,
        data: { ...d, head },
      });
      if (filed.outcome !== "written")
        unfiled.push(`${d.file}: ${filed.outcome}`);
    }
    // Every divergence was attempted first; a report that could not be filed
    // fails the run loudly rather than leaving only a log line.
    if (unfiled.length > 0) {
      throw new Error(
        `type-check backstop: ${unfiled.length} divergence report(s) not filed: ${unfiled.join("; ")}`,
      );
    }
  },
});
