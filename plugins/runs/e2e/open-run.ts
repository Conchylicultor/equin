// Debug → Builds (the merged runs list, a Meta-DataView): a row goes where
// ITS arm sends it (`runLinks` — data-view's per-arm CollectionRowActivation).
//
// Opens /debug/build, clicks the first row of `--kind` (default build), and
// checks the URL moved to that arm's detail pane (`--expect`, a path
// fragment: `/r/` for a build, `/br/` for a backup).
//
// Usage:
//   ./singularity run plugins/runs/e2e/open-run.ts [--kind backup --expect /br/] [--out /tmp/open-run]

import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const kind = arg("kind") ?? "build";
const expect = arg("expect") ?? "/r/";
const out = arg("out") ?? "/tmp/open-run";
const r = report(`Runs: a ${kind} row opens its arm's pane`);

await withBrowser(async (h) => {
  const { page } = await h.session();
  await page.goto(pathUrl("/debug/build"));

  // Rows are keyed by the union row key `kind:id`.
  const row = page.locator(`[data-row-key^="${kind}:"]`).first();
  await row.waitFor({ timeout: 30_000 });
  const before = new URL(page.url()).pathname;
  await row.click();
  await page.waitForURL((u) => u.pathname !== before, { timeout: 15_000 });
  const after = new URL(page.url()).pathname;
  r.ok(
    `the URL moved to the ${kind} arm's pane (${after})`,
    after.includes(expect),
  );
  await snap(page, out, "opened");
  return true;
});

await r.finish();
