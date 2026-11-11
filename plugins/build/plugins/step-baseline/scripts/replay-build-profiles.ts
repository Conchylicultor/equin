// Replay recorded build profiles through the step-baseline detector, oldest
// first, each judged against the builds before it — what the build itself does
// at its end, over history. Prints every regression, and a per-day count.
//
//   ./equin run plugins/build/plugins/step-baseline/scripts/replay-build-profiles.ts \
//     [--checkout <name>]   # one checkout's own series (default: main's)
//     [--host]              # every checkout's profiles as one series
//     [--since 2026-10-01] [--quiet-steps]
//
// `--host` exists because a checkout keeps only its newest 50 profiles: main's
// from 2026-11-03/04 are gone, while agent checkouts that built across the
// incident still hold theirs. One host-wide series is the only recorded view
// of those days; the build judges main's own series.
import { join } from "node:path";
import { readdir, readFile } from "@plugins/packages/plugins/timed-fs/core";
import { worktreesDir } from "@plugins/infra/plugins/paths/server";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import {
  buildIdTime,
  detectStepRegressions,
  readBuildSteps,
  stepRegressionLine,
  type BuildSteps,
  type ProfileLike,
} from "../core";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const host = args.includes("--host");
const checkout = flag("--checkout") ?? MAIN_WORKTREE_NAME;
const since = Date.parse(flag("--since") ?? "1970-01-01");

const PROFILE = /^build-profile-(build-\d{10}-[a-z0-9]+)\.json$/;

async function profilesOf(dir: string): Promise<BuildSteps[]> {
  const names = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return [] as string[];
    throw err;
  });
  const out: BuildSteps[] = [];
  for (const name of names) {
    const m = PROFILE.exec(name);
    if (!m) continue;
    const buildId = m[1]!;
    const at = buildIdTime(buildId);
    if (at === null || at < since) continue;
    const profile = JSON.parse(
      await readFile(join(dir, name), "utf8"),
    ) as ProfileLike;
    out.push(readBuildSteps(buildId, at, profile));
  }
  return out;
}

const root = worktreesDir();
const dirs = host
  ? (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name))
  : [join(root, checkout)];
const builds = (await Promise.all(dirs.map(profilesOf)))
  .flat()
  .sort((a, b) => a.at - b.at);

console.log(
  `${builds.length} builds (${host ? "host-wide" : checkout}), ` +
    `${builds.filter((b) => b.rebuiltNothing === true).length} rebuilt nothing, ` +
    `${builds.filter((b) => [...b.steps.values()].some((s) => s.fs !== null)).length} with file counts`,
);
const perDay = new Map<string, { builds: number; fired: number }>();
for (let i = 0; i < builds.length; i++) {
  const b = builds[i]!;
  const day = new Date(b.at).toISOString().slice(0, 10);
  const d = perDay.get(day) ?? { builds: 0, fired: 0 };
  d.builds++;
  perDay.set(day, d);
  const found = detectStepRegressions(b, builds.slice(0, i));
  if (found.length === 0) continue;
  d.fired++;
  console.log(`${new Date(b.at).toISOString().slice(0, 16)} ${b.buildId}`);
  for (const r of found) console.log(`  ${stepRegressionLine(r)}`);
}
console.log("\nday         builds  with a regression");
for (const [day, d] of perDay)
  console.log(`${day}  ${String(d.builds).padStart(6)}  ${d.fired}`);
