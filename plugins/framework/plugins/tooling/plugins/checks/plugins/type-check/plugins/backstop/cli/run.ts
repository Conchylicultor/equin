import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { repoProgram } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  TYPE_CHECK_DIVERGENCE_KIND,
  TYPE_CHECK_WORKER_UNITS,
  type TypeCheckWorkerResult,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/core";
import { readTypeCheckTree } from "@plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/cli";
import { spawnTypeCheckWorker } from "@plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/server";
import type { Grant } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import {
  inheritedGrant,
  withHostGrant,
} from "@plugins/infra/plugins/host/plugins/host-admission/server";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/plugins/file/core";

// Reports filed per run. A divergence is a key bug, so one is enough to act on;
// a hundred are the same bug seen a hundred times, and every one is logged.
const MAX_REPORTS = 20;

// A wedge-breaker for one metadata read, not a latency budget.
const GIT_TIMEOUT_MS = 30_000;

/**
 * One backstop run (the daily `type-check.backstop` job's child, `../server`):
 * the worker in `dual` mode on this checkout's HEAD, every divergence logged
 * and filed. stdout/stderr are the transcript the job tails into its log.
 */
const run: CliAction<[], object> = async () => {
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
  const tree = await readTypeCheckTree(root, program.tsconfigPath);
  const spawn = async (grant: Grant): Promise<TypeCheckWorkerResult> =>
    (
      await spawnTypeCheckWorker({
        root,
        name: program.name,
        tsconfigPath: program.tsconfigPath,
        tree,
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
          work: "type-check-backstop",
        },
        spawn,
      );
  for (const line of result.tscLines) console.log(line);
  const { check, full } = result.phaseCpuSeconds;
  console.log(
    `backstop at ${head}: cpu two-program check ${check.toFixed(1)}s, full ${full.toFixed(1)}s; ${result.divergences.length} divergences`,
  );

  const unfiled: string[] = [];
  for (const [i, d] of result.divergences.entries()) {
    console.error(`DIVERGES ${d.kind} ${d.file}`);
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
};

export default run;
