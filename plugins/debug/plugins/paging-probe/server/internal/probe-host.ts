import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "@plugins/config_v2/server";
import { worktreeDataDir } from "@plugins/infra/plugins/paths/server";
import {
  defineDaemon,
  type DaemonInstance,
} from "@plugins/infra/plugins/spawn/plugins/daemon/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { pagingProbeConfig } from "../../core";
import { PROBE_VARIANTS, type ProbeVariant } from "../../core/probe-logic";

// The paging-probe child-stderr drain channel. Declared once at module eval
// (`defineLogSink` throws on a duplicate id); the supervisor drains each child's
// stderr into it. Config-gated OFF by default — the probe MEASUREMENTS go to the
// paging-probe-<variant>.jsonl files, not this channel.
const channel = defineLogSink({
  id: "paging-probe",
  description:
    "Config-gated (OFF by default) twin-probe child stderr drain (paging-probe). The probe measurements go to paging-probe-<variant>.jsonl, not this channel.",
});

// The twin probes: one child process per variant, started and supervised by
// the daemon primitive (respawn with capped backoff, rapid-failure give-up,
// healthy once a probe outlives the rapid-exit window — a probe has no ready
// frame) and listed in Background activity. No vendored-release path — the
// probes are main-dev-only (server/index.ts gates on isMain() && !isRelease()),
// so `bun …/probe/entry.ts` always resolves from source.

export const pagingProbeDaemon = defineDaemon({
  name: "paging-probe.probe",
  description:
    "Twin paging probes (lean / fat-idle / fat-touch): child processes with controlled heap shapes measuring event-loop lag under host memory pressure, so their divergence tells scheduling stalls from cold page faults. An experiment, off unless paging-probe.enabled is set.",
  startedBy: "boot",
  where: "main",
  restart: { kind: "backoff", healthy: "survival" },
});

let probes: DaemonInstance[] | null = null;

// probes never run in a compiled release, so no vendoring.
function probeEntryPath(): string {
  return join(import.meta.dir, "probe", "entry.ts");
}

function logsDir(): string {
  return join(worktreeDataDir(runtimeNamespace()), "logs");
}

function outPathFor(variant: ProbeVariant): string {
  return join(logsDir(), `paging-probe-${variant}.jsonl`);
}

function argvFor(variant: ProbeVariant): string[] {
  const cfg = getConfig(pagingProbeConfig);
  return [
    process.execPath,
    probeEntryPath(),
    variant,
    "--fat-size-mb",
    String(cfg.fatSizeMb),
    "--touch-slice-mb",
    String(cfg.touchSliceMb),
    "--gc-each-minute",
    cfg.gcEachMinute ? "1" : "0",
    "--boost-qos",
    cfg.boostQos ? "1" : "0",
    "--out",
    outPathFor(variant),
  ];
}

export function startPagingProbes(): void {
  if (probes) return;
  // The child probes write their JSONL directly via appendFileSync (no plugin
  // runtime, no Log.channel), which errors on a missing dir. On main the logs
  // dir already exists, but ensure it so a fresh box never spuriously trips the
  // rapid-failure give-up.
  mkdirSync(logsDir(), { recursive: true });
  // NOT wrapped in backgroundArgv / darwinbg and NOT demoted: the fair twin is a
  // DEFAULT-QoS process — the symptom under test is that normal, un-demoted apps
  // stay responsive while main freezes. boostQos (when set) is applied by the
  // child itself via a copied pthread FFI; a parent cannot set a child's QoS.
  // stdout is ignored — the probe writes its samples to the JSONL file and
  // prints nothing; its stderr (degradation / lifecycle lines) and the
  // supervisor's own lines go to the paging-probe channel, durable and
  // readable while the box is wedged.
  probes = PROBE_VARIANTS.map((variant) =>
    pagingProbeDaemon.spawnProcess({
      instance: variant,
      // A function: each respawn reads the current config.
      argv: () => argvFor(variant),
      onStderrLine: (line) => channel.publish(`[${variant}] ${line}`),
      onLog: (line) => channel.publish(line),
    }),
  );
}

export async function stopPagingProbes(): Promise<void> {
  const running = probes;
  if (!running) return;
  probes = null;
  // SIGTERM: the probe's handler clears its interval and exits 0.
  await Promise.all(running.map((p) => p.stop()));
}
