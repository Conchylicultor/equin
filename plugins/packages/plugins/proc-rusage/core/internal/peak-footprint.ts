import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  envEntries,
  readEnv,
  readEnvPath,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { readProcRusage } from "./proc-rusage";

// A child's PEAK physical footprint — how much memory the run needed, as the
// kernel charges it — reported by the child itself as it exits.
//
// The parent cannot read it: `ri_lifetime_max_phys_footprint` is readable only
// while the process exists, and Bun reaps a child (and hands back getrusage's
// `maxRSS`, a peak RESIDENT size that counts freed pages: see
// `./proc-rusage.ts`) before the parent's code runs. So the child reads its own
// at exit, through a preload the parent puts in its environment
// (`BUN_OPTIONS=--preload …`, `../../bin/peak-footprint-preload.ts`), and
// writes it to a file the parent named. A child that never writes one (not a
// bun script, killed by a signal) is `unmeasured` — never zero, never RSS.
//
// The preload only works for a bun SCRIPT run (`bun <file>`): `bun install`,
// `bun x`, `bun build` read the preload option as their script name and fail.
// Hence opt-in, by the spawner that knows what it starts.

/** What a child needed at its peak, as the kernel charges it. */
export type PeakFootprint =
  | { kind: "measured"; bytes: number }
  | {
      kind: "unmeasured";
      /**
       * `not-requested` — the spawner did not ask (the child is not a bun
       * script); `no-report` — asked, but the child wrote none (killed by a
       * signal, or not a bun process after all); `unsupported` — not macOS.
       */
      why: "not-requested" | "no-report" | "unsupported";
    };

const PRELOAD = fileURLToPath(
  new URL("../../bin/peak-footprint-preload.ts", import.meta.url),
);

/**
 * The variables to add to a bun script child's environment so it reports its
 * peak footprint to `reportPath` as it exits. `env` is the environment the
 * child would otherwise get: its own `BUN_OPTIONS` are kept, and handed back to
 * the child's own children by the preload, which also removes these variables
 * so a grandchild never overwrites the report.
 */
export function peakFootprintReportEnv(
  reportPath: string,
  env: Record<string, string | undefined>,
): Record<string, string> {
  if (/\s/.test(PRELOAD)) {
    // BUN_OPTIONS splits on whitespace and has no quoting (bun 1.4.4: a quoted
    // path is read with its quotes), so a path with a space has no spelling.
    throw new Error(
      `[proc-rusage] the peak-footprint preload's path holds whitespace, which BUN_OPTIONS cannot carry: ${PRELOAD}`,
    );
  }
  const base = env.BUN_OPTIONS;
  return {
    BUN_OPTIONS: `${base === undefined ? "" : `${base} `}--preload ${PRELOAD}`,
    ...envEntries({ PEAK_FOOTPRINT_REPORT: reportPath }),
    ...(base === undefined
      ? {}
      : envEntries({ PEAK_FOOTPRINT_BASE_BUN_OPTIONS: base })),
  };
}

/** The report this process owes, once the preload armed it. */
let armed: { reportPath: AppPath; baseBunOptions: string | undefined } | null =
  null;

/**
 * Called by the preload, first thing in a child whose spawner asked for its
 * peak: takes the request out of the environment — restoring the
 * `BUN_OPTIONS` the child would have had, so its own children neither load
 * the preload nor overwrite this report — and writes the report as the
 * process exits. A process nobody asked (a worker thread loading the same
 * preload, a child of a child) finds no request and changes nothing.
 */
export function armPeakFootprintReportSync(): void {
  // A path in the spawn's own private temp dir (`infra/spawn`): app-owned.
  const reportPath = readEnvPath("PEAK_FOOTPRINT_REPORT");
  if (reportPath === undefined) return;
  const baseBunOptions = readEnv("PEAK_FOOTPRINT_BASE_BUN_OPTIONS");
  unsetEnv("PEAK_FOOTPRINT_REPORT");
  unsetEnv("PEAK_FOOTPRINT_BASE_BUN_OPTIONS");
  if (baseBunOptions === undefined) delete process.env.BUN_OPTIONS;
  else process.env.BUN_OPTIONS = baseBunOptions;
  armed = { reportPath, baseBunOptions };
  process.on("exit", () => {
    if (armed === null) return; // handed off to a re-exec
    const read = readProcRusage(process.pid);
    // Not macOS: no report, which the parent reads as `unsupported`.
    if (read.kind !== "read") return;
    const tmp = asAppPath(`${armed.reportPath}.${process.pid}.tmp`);
    writeFileSync(
      tmp,
      JSON.stringify({
        peakPhysFootprintBytes: read.memory.peakPhysFootprintBytes,
      }),
    );
    renameSync(tmp, armed.reportPath);
  });
}

/**
 * For a process about to hand its whole job to a fresh process (a re-exec):
 * the environment entries that pass its pending report request on, so the
 * process that does the work reports — and this one, a thin wrapper by then,
 * no longer will. Empty when no report was asked of this process.
 */
export function handOffPeakFootprintReport(): Record<string, string> {
  if (armed === null) return {};
  const { reportPath, baseBunOptions } = armed;
  armed = null;
  const env: Record<string, string | undefined> = { ...process.env };
  if (baseBunOptions === undefined) delete env.BUN_OPTIONS;
  else env.BUN_OPTIONS = baseBunOptions;
  return peakFootprintReportEnv(reportPath, env);
}

/** What the child at `reportPath` reported, once it has exited. */
export async function readPeakFootprintReport(
  reportPath: string,
): Promise<PeakFootprint> {
  if (process.platform !== "darwin")
    return { kind: "unmeasured", why: "unsupported" };
  // Written to a temporary name and renamed into place, so the file is
  // either absent or whole.
  let text: string;
  try {
    text = await readFile(reportPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "unmeasured", why: "no-report" };
    throw err;
  }
  const report = JSON.parse(text) as { peakPhysFootprintBytes?: unknown };
  const bytes = report.peakPhysFootprintBytes;
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) {
    throw new Error(
      `[proc-rusage] malformed peak-footprint report at ${reportPath}: ${text}`,
    );
  }
  return { kind: "measured", bytes };
}

/** "1.2 GB" / "640 MB" — decimal units, like every memory line we print. */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

/**
 * A peak footprint as printed in a log line: "peak footprint 1.2 GB", or why
 * there is no number. One spelling, so `grep "peak footprint"` finds them all.
 */
export function peakFootprintText(peak: PeakFootprint): string {
  return peak.kind === "measured"
    ? `peak footprint ${formatBytes(peak.bytes)}`
    : `peak footprint unmeasured (${peak.why})`;
}
