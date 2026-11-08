import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  envEntries,
  readEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { readFileSync } from "@plugins/packages/plugins/timed-fs/core";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import type { OpProfiler } from "@plugins/debug/plugins/profiling/plugins/op-log/cli";
import type { Grant } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { spawnPassthrough } from "@plugins/infra/plugins/spawn/core";

// The hand-off between a push and its LAND PHASE — everything after the rebase,
// run as a child on the rebased code (`./land.ts`).
//
// Why a child at all: the push rebases its own checkout, so from the rebase on
// the process that started the push is OLDER than the tree it stands in. Left
// running, it mixes versions — its children run the new tree while it keeps the
// old one in memory, yet still reads the tree by path (a script it spawns, a
// lazy import) and leans on on-disk layout (its own executable). On 2026-11-06
// a rebase brought in a change that deleted the old process's executable name,
// and the push died at its last step, after remote main had moved
// (research/2026-11-06-cli-push-post-rebase-handoff.md).
//
// So the push driver, after the rebase, does only this: spawn the land phase,
// wait, record what it reports. The driver keeps holding the push mutex and the
// host grant — the land phase runs INSIDE that hold (the grant handed down by
// env like the checks' — `grant.env()` → `inheritedGrant()`), so nothing is
// re-queued and the lock never crosses a process.
//
// This file is the WHOLE contract between two versions of the code: the driver
// is the checkout's code before the rebase, the land phase after it. Every shape
// here carries `v`; a reader that meets a `v` it does not know fails loudly.
// Change a shape → bump `v`, and keep reading the previous one until no
// checkout older than the change is left to push.

/** What the driver hands the land phase (env `PUSH_LAND`, JSON). */
const LandPayload = z.object({
  v: z.literal(1),
  /** The push's op id: the trailer the rebase stamped, the op the driver records. */
  pushId: z.string().min(1),
  /** Which landing the land phase runs. */
  mode: z.enum(["worktree", "from-main"]),
  /** Where the land phase writes its report (`worktreeArtifacts.pushLand`). */
  report: z.string().min(1),
});
export type LandPayload = z.infer<typeof LandPayload>;

/** The outcomes a land phase states. Anything else (a crash) reads as `error`. */
const LandOutcome = z.enum(["success", "failed_checks"]);
type LandOutcome = z.infer<typeof LandOutcome>;

const LandStep = z.object({
  name: z.string(),
  startedAtMs: z.number(),
  durationMs: z.number(),
});

/** What the land phase reports back, rewritten as each step ends. */
const LandReport = z.object({
  v: z.literal(1),
  /** When the land phase's own code began — after its bootstrap and install. */
  startedAtMs: z.number(),
  steps: z.array(LandStep),
  outcome: LandOutcome.optional(),
});
type LandReport = z.infer<typeof LandReport>;

/**
 * The land phase's payload, when this process IS one; else `undefined`. Taken
 * out of the env on the read, so no descendant (the checks, a regen) inherits it.
 */
export function takeLandPayload(): LandPayload | undefined {
  const raw = readEnv("PUSH_LAND");
  if (raw === undefined) return undefined;
  unsetEnv("PUSH_LAND");
  const parsed = LandPayload.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `push: this land phase cannot read the hand-off it was given (${raw}): ` +
        `${parsed.error.message}. The push that spawned it is a different version ` +
        `of handoff.ts; re-run ./equin push.`,
    );
  }
  return parsed.data;
}

/** The land phase's side of the report: one step at a time, then the outcome. */
export interface LandReporter {
  stepStart(name: string): void;
  stepEnd(name: string): void;
  complete(outcome: LandOutcome): void;
}

export function openLandReport(path: string): LandReporter {
  const report: LandReport = { v: 1, startedAtMs: Date.now(), steps: [] };
  const starts = new Map<string, number>();
  // Atomic: the driver reads it after the phase exits, however it exits, and a
  // half-written file must not read as no report at all.
  const flush = (): void => {
    const tmp = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, JSON.stringify(report));
    renameSync(tmp, path);
  };
  flush();
  return {
    stepStart: (name) => {
      starts.set(name, Date.now());
    },
    stepEnd: (name) => {
      const start = starts.get(name);
      if (start === undefined)
        throw new Error(`push: step ${name} never started`);
      starts.delete(name);
      report.steps.push({
        name,
        startedAtMs: start,
        durationMs: Date.now() - start,
      });
      flush();
    },
    complete: (outcome) => {
      report.outcome = outcome;
      flush();
    },
  };
}

function readLandReport(path: AppPath): LandReport | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // No report: the land phase died before its own code ran (its bootstrap or
    // install failed, which printed why). The exit code says the rest.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return LandReport.parse(JSON.parse(text));
}

export type LandResult =
  | { kind: "success" }
  | { kind: "failed_checks"; exitCode: number }
  | { kind: "error"; exitCode: number };

/**
 * The driver's side: run the land phase on the rebased tree under `grant`,
 * record its steps on `profiler`, and say how it ended. Called inside the push
 * mutex, right after the rebase — nothing of the driver's own runs between the
 * rebase and this, nor after it but the record.
 *
 * Spawned through the `./equin` script, never `process.execPath`: the script
 * resolves the Bun to run from the rebased tree, and the driver's own executable
 * is exactly the kind of path a rebase may have moved. Frozen lockfile, since the
 * child's bootstrap installs what the rebase brought in and a mid-push tree must
 * not be re-resolved.
 */
export async function runLandPhase(opts: {
  root: AppPath;
  pushId: string;
  mode: LandPayload["mode"];
  reportPath: AppPath;
  grant: Grant;
  profiler: OpProfiler<"push">;
}): Promise<LandResult> {
  const { root, reportPath, profiler } = opts;
  rmSync(reportPath, { force: true });
  const payload: LandPayload = {
    v: 1,
    pushId: opts.pushId,
    mode: opts.mode,
    report: reportPath,
  };
  const spawnedAtMs = Date.now();
  const { exitCode } = await spawnPassthrough([join(root, CLI_NAME), "push"], {
    cwd: root,
    env: {
      ...process.env,
      ...opts.grant.env(),
      ...envEntries({
        FROZEN_LOCKFILE: "1",
        PUSH_LAND: JSON.stringify(payload),
      }),
    },
    stdin: "inherit",
  });
  const report = readLandReport(reportPath);
  rmSync(reportPath, { force: true });

  // The land phase's boot — its bootstrap and the install of the rebased
  // lockfile — up to its own first line, then each step it ran.
  const bootEndMs = report?.startedAtMs ?? Date.now();
  profiler.recordStep("land-boot", bootEndMs - spawnedAtMs, spawnedAtMs);
  for (const step of report?.steps ?? [])
    profiler.recordStep(step.name, step.durationMs, step.startedAtMs);

  if (exitCode === 0) {
    if (report?.outcome === "success") return { kind: "success" };
    throw new Error(
      `push: the land phase exited 0 without reporting success ` +
        `(report: ${report === undefined ? "none" : JSON.stringify(report)}).`,
    );
  }
  if (report?.outcome === "failed_checks")
    return { kind: "failed_checks", exitCode };
  return { kind: "error", exitCode };
}
