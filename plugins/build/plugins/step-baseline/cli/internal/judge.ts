import { join } from "node:path";
import { readdir, readFile } from "@plugins/packages/plugins/timed-fs/core";
import {
  worktreeArtifacts,
  worktreeDataDir,
} from "@plugins/infra/plugins/paths/server";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import { fileReportFromProcess } from "@plugins/reports/plugins/outbox/core";
import {
  buildIdTime,
  detectStepRegressions,
  readBuildSteps,
  STEP_REGRESSION_KIND,
  stepRegressionLine,
  type BuildSteps,
  type ProfileLike,
  type StepRegressionPayload,
} from "../../core";

export interface JudgeBuildStepsOptions {
  /** The checkout's namespace: its data dir holds its build profiles. */
  name: Namespace;
  /** This build, whose profile is already written. */
  buildId: string;
}

const PROFILE = /^build-profile-(build-\d{10}-[a-z0-9]+)\.json$/;

async function readSteps(path: string, buildId: string): Promise<BuildSteps> {
  const at = buildIdTime(buildId);
  if (at === null) throw new Error(`build id without a time: ${buildId}`);
  const profile = JSON.parse(await readFile(path, "utf8")) as ProfileLike;
  return readBuildSteps(buildId, at, profile);
}

/**
 * Judge this build's steps against the checkout's earlier builds (the
 * profiles its data dir keeps, `BUILD_ARTIFACTS_RETENTION`), and file each
 * regression as a `build-step-regression` report through the outbox. Returns
 * the lines to print. Main's builds only: theirs is the one steady series (one
 * build per push, ~100 a day, mostly rebuilding nothing); an agent checkout's
 * few builds of a moving branch are no baseline.
 */
export async function judgeBuildSteps(
  opts: JudgeBuildStepsOptions,
): Promise<string[]> {
  const { name, buildId } = opts;
  const current = await readSteps(
    worktreeArtifacts.buildProfile(name, buildId),
    buildId,
  );
  if (current.rebuiltNothing !== true) return [];
  const dir = worktreeDataDir(name);
  const history: BuildSteps[] = [];
  for (const entry of await readdir(dir)) {
    const m = PROFILE.exec(entry);
    if (!m || m[1] === buildId) continue;
    history.push(await readSteps(join(dir, entry), m[1]!));
  }
  const found = detectStepRegressions(current, history);
  const lines: string[] = [];
  for (const r of found) {
    const data: StepRegressionPayload = {
      ...r,
      buildId,
      checkout: name,
    };
    const message = stepRegressionLine(r);
    // No `code`: a step that slowed may be the host under it, not a source
    // file — the outbox's staleness rule has nothing to compare.
    const filed = await fileReportFromProcess({
      kind: STEP_REGRESSION_KIND,
      message,
      data,
    });
    lines.push(
      filed.outcome === "written"
        ? `⚠ step regression: ${message} — filed a ${STEP_REGRESSION_KIND} report`
        : `⚠ step regression: ${message} — could not file the report (${filed.outcome})`,
    );
  }
  return lines;
}
