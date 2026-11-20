import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { repoProgram } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  TYPE_CHECK_DIVERGENCE_KIND,
  typeCheckWorkerUnits,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/core";
import { readTypeCheckTree } from "@plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/cli";
import {
  spawnTypeCheckWorker,
  type TypeCheckWorkerRun,
} from "@plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/server";
import type { Grant } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import {
  inheritedGrant,
  withHostGrant,
} from "@plugins/infra/plugins/host/plugins/host-admission/server";
import {
  getWorktreeRoot,
  spawnCaptured,
} from "@plugins/infra/plugins/spawn/core";
import {
  formatBytes,
  peakFootprintText,
} from "@plugins/packages/plugins/proc-rusage/core";
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
  // Everything the run is read for happens inside the spawn's `consume`, so the
  // worker memory record is written after it (`spawnTypeCheckWorker`).
  const report = async (run: TypeCheckWorkerRun): Promise<void> => {
    const { result } = run;
    for (const line of result.tscLines) console.log(line);
    const { check, full } = result.phaseCpuSeconds;
    const oracle = result.fullCheckProcess?.peakFootprint;
    console.log(
      `backstop at ${head}: cpu two-program check ${check.toFixed(1)}s, full ${full.toFixed(1)}s; worker ${peakFootprintText(run.peakFootprint)}, full check ${oracle ? peakFootprintText(oracle) : "none"}, batches ${result.batchProcesses ? `≤ ${formatBytes(result.batchProcesses.concurrentFootprintBytes)} at once` : "none"}; ${result.divergences.length} divergences`,
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
  const spawn = (grant: Grant): Promise<void> =>
    spawnTypeCheckWorker(
      {
        root,
        name: program.name,
        tsconfigPath: program.tsconfigPath,
        tree,
        tscMode: "dual",
        onMiss: "throw",
        lintFiles: [],
        grant,
      },
      report,
    );
  // What a dual run weighs (its whole-program oracle), never a batched
  // worker's weight. RIGID: the oracle is one process as large as the whole
  // program, so unlike a batched worker it cannot shrink to a short grant —
  // admitted on fewer units, it would take ~16 GB on a share of a few.
  const units = typeCheckWorkerUnits("dual");
  const inherited = inheritedGrant();
  if (inherited) {
    if (inherited.units < units)
      throw new Error(
        `type-check backstop: the inherited grant holds ${inherited.units} unit(s), and a dual run weighs ${units} (its whole-program oracle cannot run in less) — run it outside a grant holder, where it takes its own`,
      );
    await spawn(inherited);
  } else
    await withHostGrant(
      {
        lane: "background",
        priority: "normal",
        max: units,
        min: units,
        work: "type-check-backstop",
      },
      spawn,
    );
};

export default run;
