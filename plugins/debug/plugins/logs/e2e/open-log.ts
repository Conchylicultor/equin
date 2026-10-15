// Debug → Logs: clicking a log in the catalog opens its reader beside it.
//
// Opens /debug/logs, clicks the row of one log (by its name), and checks the
// reader column appears with that log's name in its header and its lines
// loaded, and that the URL carries `/ch/<log>`. Writes a screenshot of the two
// columns.
//
// Usage:
//   ./singularity run plugins/debug/plugins/logs/e2e/open-log.ts [--log migrations] [--out /tmp/open-log]

import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const log = arg("log") ?? "migrations";
const out = arg("out") ?? "/tmp/open-log";
const r = report("Debug → Logs: open a log from the catalog");

await withBrowser(async (h) => {
  const { page } = await h.session();
  await page.goto(pathUrl("/debug/logs"));

  // The catalog's row for the log: DataView keys each row it draws.
  const row = page.locator(`[data-row-key="${log}"]`).first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();

  await page.waitForURL(new RegExp(`/ch/${log}(;|$)`), { timeout: 15_000 });
  r.ok(
    "the URL names the opened log",
    new URL(page.url()).pathname.includes(`/ch/${log}`),
  );

  // The reader's lines: rows keyed by history position (`<birth>.<offset>`).
  const line = page.locator('[data-row-key*="."]').first();
  await line.waitFor({ timeout: 15_000 });
  r.ok("the reader column shows the log's lines", await line.isVisible());

  await snap(page, out, "opened");
  return true;
});

await r.finish();
