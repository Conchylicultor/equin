import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { CliAction } from "@plugins/framework/plugins/cli/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  exists,
  readdir,
  readFile,
} from "@plugins/packages/plugins/timed-fs/core";
import {
  INSTALL_ESTIMATES,
  InstallStepId,
  InstallTiming,
  estimatesFrom,
  findEstimatesBlock,
  parseInstallEventLine,
  renderEstimatesBlock,
  timingFromEvents,
  type InstallEstimates,
  type InstallEvent,
} from "@plugins/installer/core";
import { installRunsDir } from "@plugins/installer/data-dirs";

const ESTIMATES_JSON = "plugins/installer/core/estimates.json";

/**
 * `./equin installer estimates` — the per-step medians every install shows
 * its time left from: read each real install's run dir (this machine's
 * install runs, plus `--from <dir>` for run dirs collected elsewhere) — its
 * `timing.json`, else the `events.jsonl` it was read from — take each step's
 * median, and write `installer/core/estimates.json` and install.sh's
 * generated copy of it. A dry run's timings are never counted.
 * `--only <step…>` re-measures only those steps (a fix changed them since the
 * runs that measured the rest): every other step keeps its committed estimate.
 * `--from-json` rewrites only install.sh's block from the committed JSON.
 */
const run: CliAction<
  [],
  { from?: string[]; only?: string[]; fromJson?: boolean }
> = async (opts) => {
  let estimates: InstallEstimates = INSTALL_ESTIMATES;
  if (opts.fromJson !== true) {
    const dirs = [installRunsDir.path, ...(opts.from ?? [])];
    const only =
      opts.only === undefined
        ? undefined
        : new Set(opts.only.map((id) => InstallStepId.parse(id)));
    const timings = (await Promise.all(dirs.map(readTimings))).flat();
    if (timings.length === 0)
      throw new Error(
        `no finished install runs in ${dirs.join(", ")} — a real install writes <run>/events.jsonl, and <run>/timing.json when it finishes`,
      );
    const measured = estimatesFrom(timings);
    estimates =
      only === undefined
        ? measured
        : {
            installs: Math.max(INSTALL_ESTIMATES.installs, measured.installs),
            steps: Object.fromEntries(
              InstallStepId.options.map((id) => [
                id,
                only.has(id) ? measured.steps[id] : INSTALL_ESTIMATES.steps[id],
              ]),
            ) as InstallEstimates["steps"],
          };
    await writeFile(
      join(REPO_ROOT, ESTIMATES_JSON),
      `${JSON.stringify(estimates, null, 2)}\n`,
    );
    console.log(`${ESTIMATES_JSON}: medians over ${timings.length} install(s)`);
  }
  const scriptPath = join(REPO_ROOT, "install.sh");
  const script = await readFile(scriptPath, "utf8");
  const found = findEstimatesBlock(script);
  if (!found.ok) throw new Error(found.error);
  await writeFile(
    scriptPath,
    script.slice(0, found.start) +
      renderEstimatesBlock(estimates) +
      script.slice(found.end),
  );
  console.log("install.sh: estimates block written");
};

/**
 * Every finished real install's timing under `dir`: one per `<run>/` holding
 * a `timing.json`, else an `events.jsonl` that reached `done`.
 */
async function readTimings(dir: string): Promise<InstallTiming[]> {
  if (!(await exists(dir))) return [];
  const out: InstallTiming[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const timing = await readRunTiming(join(dir, entry.name));
    if (timing !== undefined && !timing.dryRun) out.push(timing);
  }
  return out;
}

/** One run dir's timing; undefined for a dir that is no finished install run. */
async function readRunTiming(
  runDir: string,
): Promise<InstallTiming | undefined> {
  const timingPath = join(runDir, "timing.json");
  if (await exists(timingPath)) {
    const parsed = InstallTiming.safeParse(
      JSON.parse(await readFile(timingPath, "utf8")),
    );
    if (!parsed.success)
      throw new Error(
        `${timingPath} is not an install timing file: ${parsed.error.message}`,
      );
    return parsed.data;
  }
  const eventsPath = join(runDir, "events.jsonl");
  if (!(await exists(eventsPath))) return undefined;
  const events: InstallEvent[] = [];
  const lines = (await readFile(eventsPath, "utf8")).split("\n");
  for (const [i, line] of lines.entries()) {
    if (line === "") continue;
    const parsed = parseInstallEventLine(line);
    if (!parsed.ok) throw new Error(`${eventsPath}:${i + 1}: ${parsed.error}`);
    events.push(parsed.event);
  }
  const timing = timingFromEvents(events);
  if (timing.ok) return timing.timing;
  // An unfinished run (it failed, or was stopped) measured nothing whole.
  console.log(`${eventsPath}: skipped — ${timing.error}`);
  return undefined;
}

export default run;
