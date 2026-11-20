// What an `exec` child (a supervised job's process) pays to start, measured on
// the real path: this script IS an exec child — it calls `runExec` with a body
// that only reports, so everything before the body is exactly the boot a job
// pays (graph import, register, contributions, the `onReadyBlocking` barrier).
//
//   ./equin run plugins/framework/plugins/server-core/scripts/exec-boot-cost.ts \
//     --namespace <ns> [--json] [--start <pluginPath> [--reads <kind>,…]]
//
// `--start` boots the way a job that declares its `reads` does
// (`defineSupervisedJob`): only that plugin and what it needs
// (`resolveStartSet`), the list rule armed — so a complete list read while
// starting throws here exactly as it would in the job.
//
// `<ns>` must be a namespace whose serving backend has booted THIS checkout's
// code (its own worktree after `./equin build`): an exec child only verifies
// the schema, and refuses when its owner has not set it up for this code.
//
// Prints one line of JSON (with --json) or a table: wall and CPU from process
// start to each boot checkpoint (`after-import` = every plugin barrel imported,
// `after-onReadyBlocking` = ready to run the job), the slowest blocking hooks,
// and how many modules / plugins the process holds when the job would start.
// Process start → this script's first line (Bun start + `./equin run`'s own
// wrapper is NOT in it — run the whole command under `/usr/bin/time -l` for
// that) is reported as `preScriptMs`.
//
// Used for the 2026-11-19 re-measure on the "Import time and lazy imports"
// track (task-1795102932-gsolx4). Repeat it a few times: single runs are noisy
// on a loaded machine; CPU-s is the steadier figure.
import { parseArgs } from "node:util";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { getProfilingData } from "../core";
import { runExec } from "../cli";

const { values } = parseArgs({
  options: {
    namespace: { type: "string" },
    json: { type: "boolean" },
    start: { type: "string" },
    reads: { type: "string" },
  },
});
if (values.namespace === undefined)
  throw new Error("--namespace <ns> is required");

const preScriptMs = performance.now();
const cpu0 = process.cpuUsage();

const start =
  values.start === undefined
    ? undefined
    : {
        root: values.start,
        reads:
          values.reads === undefined || values.reads === ""
            ? []
            : values.reads.split(","),
        label: `exec-boot-cost --start ${values.start}`,
        fix: (kind: string) => `pass --reads ${kind} (or classify the list)`,
      };

await runExec(
  asNamespace(values.namespace),
  async () => {
    const cpu = process.cpuUsage();
    const profile = getProfilingData();
    const { serverEntries, machineEntries } =
      await import("../bin/active-runtime");
    // Started, not registered: a partial start loads only its set.
    const started = new Set(
      Object.keys(require.cache).flatMap((p) => {
        const m = /\/plugins\/(.+?)\/(server|machine)\/index\.ts$/.exec(p);
        return m === null ? [] : [`${m[1]}#${m[2]}`];
      }),
    ).size;
    // Bun lists every loaded module, ESM included, in require.cache.
    const loaded = Object.keys(require.cache);
    const repoModules = loaded.filter(
      (p) => !p.includes("/node_modules/"),
    ).length;
    const blocking = profile.spans
      .filter((s) => s.phase === "onReadyBlocking")
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 8)
      .map((s) => ({ label: s.label, ms: Math.round(s.durationMs) }));
    // Checkpoint offsets start at the profiler module's evaluation; shift them
    // onto the process clock so they line up with `preScriptMs`.
    const base = profile.bootStartOffsetMs;
    const result = {
      preScriptMs: Math.round(preScriptMs),
      checkpoints: profile.memoryCheckpoints.map((c) => ({
        label: c.label,
        wallMs: Math.round(base + c.atMs),
        cpuMs: c.cpuMs === undefined ? null : Math.round(c.cpuMs),
      })),
      bodyWallMs: Math.round(performance.now()),
      bodyCpuMs: Math.round((cpu.user + cpu.system) / 1000),
      scriptCpuMs: Math.round(
        (cpu.user - cpu0.user + cpu.system - cpu0.system) / 1000,
      ),
      plugins: serverEntries.length + machineEntries.length,
      started,
      modules: {
        total: loaded.length,
        repo: repoModules,
        npm: loaded.length - repoModules,
      },
      slowestBlockingHooks: blocking,
    };
    if (values.json) {
      console.log(JSON.stringify(result));
      return;
    }
    console.log(`process start → script: ${result.preScriptMs} ms`);
    for (const c of result.checkpoints)
      console.log(
        `${c.label.padEnd(24)} wall ${c.wallMs} ms  cpu ${c.cpuMs} ms`,
      );
    console.log(
      `job body starts         wall ${result.bodyWallMs} ms  cpu ${result.bodyCpuMs} ms`,
    );
    console.log(
      `plugins ${result.started} started of ${result.plugins}, modules ${result.modules.total} (repo ${result.modules.repo}, npm ${result.modules.npm})`,
    );
    for (const h of blocking)
      console.log(`  onReadyBlocking ${h.label}: ${h.ms} ms`);
  },
  start === undefined ? {} : { start },
);
