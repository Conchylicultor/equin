// A burst of page edits on a deployed build: one keystroke every --gap ms,
// --edits times, into a fresh page — the shape of someone typing or an agent
// editing (main, 2026-11-08: 322 of 396 page.blocksChanged emits came < 5 s
// after the previous one for the same page). The page is trashed at the end,
// and the run then waits --settle ms more so the trash's subscribers run too.
//
// Prints the job runs the burst caused, per job name (the `job_run_stats.runs`
// delta across it, read from the target deploy's own database), against the
// `page.blocksChanged` emissions it made — so what one edit costs is a number
// this script states, not a query to retype. Other work on the deploy in the
// same window (a scheduled job) shows up in the delta too: run it on an idle
// worktree build.
//
// Usage:
//   ./equin run plugins/page/plugins/editor/e2e/edit-burst.ts \
//     [--edits 20] [--gap 1500] [--settle 15000]

import {
  agentFetch,
  numArg,
  openDeployDb,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage } from "./index";

const edits = numArg("edits", 20);
const gapMs = numArg("gap", 1500);
// Long enough after the last edit for every settled subscriber to have run.
const settleMs = numArg("settle", 15_000);

const r = report("page edit burst");
const deployDb = openDeployDb();

async function jobRuns(): Promise<Map<string, number>> {
  const rows = await deployDb.query<{ job_name: string; runs: number }>(
    "SELECT job_name, runs FROM job_run_stats",
  );
  return new Map(rows.map((row) => [row.job_name, Number(row.runs)]));
}

try {
  const before = await jobRuns();
  const start = new Date().toISOString();
  let pageId = "";
  await withBrowser(async (h) => {
    const { page, captured } = await h.session();
    ({ pageId } = await openBlankPage(page, { settleMs: 2000 }));
    try {
      for (let i = 0; i < edits; i++) {
        await page.keyboard.type("x");
        await page.waitForTimeout(gapMs);
      }
      await page.waitForTimeout(settleMs);
      r.ok(
        "no page errors",
        captured.pageErrors.length === 0,
        captured.pageErrors.join(" | "),
      );
    } finally {
      const res = await agentFetch(`/api/blocks/${pageId}`, {
        method: "DELETE",
      });
      r.ok("test page trashed", res.ok, `DELETE: HTTP ${res.status}`);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const end = new Date().toISOString();
  const after = await jobRuns();

  const [counted] = await deployDb.query<{ emits: number }>(
    `SELECT count(*)::int AS emits FROM event_emissions
      WHERE event_name = 'page.blocksChanged'
        AND emitted_at BETWEEN $1 AND $2`,
    [start, end],
  );
  if (counted === undefined) throw new Error("count(*) returned no row");
  const { emits } = counted;
  const deltas = [...after]
    .map(([job, runs]) => [job, runs - (before.get(job) ?? 0)] as const)
    .filter(([, d]) => d > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = deltas.reduce((sum, [, d]) => sum + d, 0);

  r.note(`pageId: ${pageId}`);
  r.note(`window: ${start} → ${end} (${edits} edits, ${gapMs} ms apart)`);
  r.note(`page.blocksChanged emits: ${emits}`);
  r.note(`job runs: ${total}`);
  for (const [job, d] of deltas) r.note(`  ${String(d).padStart(4)}  ${job}`);
} finally {
  await deployDb.close();
}

await r.finish();
