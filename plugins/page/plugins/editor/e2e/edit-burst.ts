// A burst of page edits on a deployed build: one keystroke every --gap ms,
// --edits times, into a fresh page — the shape of someone typing or an agent
// editing (main, 2026-11-08: 322 of 396 page.blocksChanged emits came < 5 s
// after the previous one for the same page). Prints the page id and the burst's
// window, so the job runs it caused can be counted (`job_runs`, by job name)
// against the `event_emissions` it made. The page is trashed at the end.
//
// Usage:
//   ./equin run plugins/page/plugins/editor/e2e/edit-burst.ts \
//     [--edits 20] [--gap 1500] [--settle 15000]

import {
  agentFetch,
  numArg,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage } from "./index";

const edits = numArg("edits", 20);
const gapMs = numArg("gap", 1500);
// Long enough after the last edit for every settled subscriber to have run.
const settleMs = numArg("settle", 15_000);

const r = report("page edit burst");

await withBrowser(async (h) => {
  const { page, captured } = await h.session();
  const { pageId } = await openBlankPage(page, { settleMs: 2000 });
  const start = new Date().toISOString();
  try {
    for (let i = 0; i < edits; i++) {
      await page.keyboard.type("x");
      await page.waitForTimeout(gapMs);
    }
    const end = new Date().toISOString();
    await page.waitForTimeout(settleMs);
    r.note(`pageId: ${pageId}`);
    r.note(`burst: ${start} → ${end} (${edits} edits, ${gapMs} ms apart)`);
    r.ok(
      "no page errors",
      captured.pageErrors.length === 0,
      captured.pageErrors.join(" | "),
    );
  } finally {
    const res = await agentFetch(`/api/blocks/${pageId}`, { method: "DELETE" });
    r.ok("test page trashed", res.ok, `DELETE: HTTP ${res.status}`);
  }
});

await r.finish();
