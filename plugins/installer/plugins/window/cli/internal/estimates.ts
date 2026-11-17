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
  InstallTiming,
  estimatesFrom,
  findEstimatesBlock,
  renderEstimatesBlock,
  type InstallEstimates,
} from "@plugins/installer/core";
import { installRunsDir } from "@plugins/installer/data-dirs";

const ESTIMATES_JSON = "plugins/installer/core/estimates.json";

/**
 * `./equin installer estimates` — the per-step medians every install shows
 * its time left from: read each real install's `timing.json` (this machine's
 * install runs, plus `--from <dir>` for timing files collected elsewhere),
 * take each step's median, and write `installer/core/estimates.json` and
 * install.sh's generated copy of it. A dry run's timings are never counted.
 * `--from-json` rewrites only install.sh's block from the committed JSON.
 */
const run: CliAction<[], { from?: string[]; fromJson?: boolean }> = async (
  opts,
) => {
  let estimates: InstallEstimates = INSTALL_ESTIMATES;
  if (opts.fromJson !== true) {
    const dirs = [installRunsDir.path, ...(opts.from ?? [])];
    const timings = (await Promise.all(dirs.map(readTimings))).flat();
    if (timings.length === 0)
      throw new Error(
        `no install timing files in ${dirs.join(", ")} — a real install writes <run>/timing.json when it finishes`,
      );
    estimates = estimatesFrom(timings);
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

/** Every real install's timing under `dir` (one `<run>/timing.json` each). */
async function readTimings(dir: string): Promise<InstallTiming[]> {
  if (!(await exists(dir))) return [];
  const out: InstallTiming[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, "timing.json");
    if (!(await exists(path))) continue;
    const parsed = InstallTiming.safeParse(
      JSON.parse(await readFile(path, "utf8")),
    );
    if (!parsed.success)
      throw new Error(
        `${path} is not an install timing file: ${parsed.error.message}`,
      );
    if (!parsed.data.dryRun) out.push(parsed.data);
  }
  return out;
}

export default run;
