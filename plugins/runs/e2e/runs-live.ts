/**
 * Proves the merged run surface is the LIVE `runs` union window (step 12 of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md), with no
 * reload:
 *
 *  1. a running backup seeded into `backup_runs` appears on the Backup pane,
 *     and its "Took" cell TICKS (the browser's elapsed time — the server's
 *     duration is NULL while it runs);
 *  2. the run finishes (status, finished_at, archive size): its row and the
 *     backup deep link (`/debug/backup/br/<id>`) update in place;
 *  3. a deploy run on a seeded server shows `<composition> on <server name>`
 *     on the Builds pane's Shipping tab; RENAMING the server relabels the row
 *     live — the label is a lookup over `deploy_servers`, routed by the
 *     server's change, not a correlated subquery nothing could route.
 *
 * The load-bearing assertion is the NO-RELOAD one: a marker stamped on
 * `window` before the first live change must survive to the end.
 *
 * Seeded rows are deleted at the end (also on failure). Refuses main (it
 * seeds rows into the deploy's database).
 *
 *   ./equin run plugins/runs/e2e/runs-live.ts [--headed]
 */
import { randomBytes } from "node:crypto";
import type { Page } from "playwright";
import {
  arg,
  boot,
  onBeforeFinish,
  openDeployDb,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/runs-live";
const db = openDeployDb();
const tag = `e2e-${randomBytes(3).toString("hex")}`;
const BACKUP = `${tag}-backup`;
const SERVER = `${tag}-srv`;
const DEPLOYMENT = `${tag}-dep`;
const DEPLOY = `${tag}-deploy`;
const COMPOSITION = `${tag}-comp`;

let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  // Only this run's own rows: another e2e seeding the same deploy DB keeps
  // its rows. Deployments and their runs cascade from the server.
  await db.query("DELETE FROM backup_runs WHERE id = $1", [BACKUP]);
  await db.query("DELETE FROM deploy_servers WHERE id = $1", [SERVER]);
  await db.close();
}
onBeforeFinish(cleanup);

/**
 * The text of the list row showing `needle`, or null: the leaf holding it,
 * widened to the tallest ancestor still one row high (a row is one line).
 */
async function rowText(page: Page, needle: string): Promise<string | null> {
  return page.evaluate((n) => {
    for (const el of document.querySelectorAll(
      '[data-ui-owner^="ListView@"] *',
    )) {
      if (el.children.length > 0 || !(el.textContent ?? "").includes(n))
        continue;
      let row: Element = el;
      while (
        row.parentElement &&
        row.parentElement.getBoundingClientRect().height < 56
      ) {
        row = row.parentElement;
      }
      return row.textContent;
    }
    return null;
  }, needle);
}

try {
  await db.query(
    `INSERT INTO backup_runs (id, trigger, started_at, status)
     VALUES ($1, $2, now() - interval '65 seconds', 'running')`,
    [BACKUP, tag],
  );

  await withBrowser(async (h) => {
    const r = report("Runs · the merged run surface is a live union window");
    const { page } = await h.session({
      viewport: { width: 1600, height: 900 },
    });
    await boot(page, pathUrl("/debug/backup"), {
      marker: '[data-ui-owner^="ListView@"]',
      timeoutMs: 120_000,
      settleMs: 1000,
    });
    await page.evaluate(() => {
      (window as unknown as { __noReload?: boolean }).__noReload = true;
    });

    // 1. The running backup is listed, and its elapsed time ticks.
    const first = await waitFor(
      () => rowText(page, tag),
      (t) => t !== null,
      { timeoutMs: 60_000 },
    );
    r.ok("the seeded running backup is listed", first.ok, String(first.value));
    await page.waitForTimeout(2500);
    const later = await rowText(page, tag);
    r.ok(
      "a running run's Took ticks on the client",
      later !== null && later !== first.value,
      `${String(first.value)} → ${String(later)}`,
    );
    await snap(page, OUT, "running");

    // 2. It finishes: the row updates in place, and so does its deep link.
    await db.query(
      `UPDATE backup_runs SET status = 'ok', finished_at = now(), archive_size_bytes = 4096
       WHERE id = $1`,
      [BACKUP],
    );
    const done = await waitFor(
      () => rowText(page, tag),
      (t) => t !== null && !/running/i.test(t),
      { timeoutMs: 30_000 },
    );
    r.ok("the finished run updates in place", done.ok, String(done.value));
    await page.goto(pathUrl(`/debug/backup/br/${BACKUP}`));
    const pane = await waitFor(
      () => page.evaluate(() => document.body.textContent ?? ""),
      (t) => t.includes("4.0 KB"),
      { timeoutMs: 30_000 },
    );
    r.ok("the backup deep link resolves the run (its archive size)", pane.ok);
    await snap(page, OUT, "deep-link");

    // 3. A deploy row's label reads its server's name — and follows a rename.
    await db.query(
      `INSERT INTO deploy_servers (id, name, host) VALUES ($1, 'before', 'localhost')`,
      [SERVER],
    );
    await db.query(
      `INSERT INTO deploy_deployments (id, composition_id, server_id, hostnames)
       VALUES ($1, $2, $3, ARRAY[]::text[])`,
      [DEPLOYMENT, COMPOSITION, SERVER],
    );
    await db.query(
      `INSERT INTO deploy_runs (id, deployment_id, server_id, composition_id, verb, status, started_at)
       VALUES ($1, $2, $3, $4, 'converge', 'running', now())`,
      [DEPLOY, DEPLOYMENT, SERVER, COMPOSITION],
    );
    await page.goto(pathUrl("/debug/build"));
    await page.getByText("Shipping", { exact: true }).first().click();
    const before = await waitFor(
      () => rowText(page, COMPOSITION),
      (t) => t !== null && t.includes(`${COMPOSITION} on before`),
      { timeoutMs: 60_000 },
    );
    r.ok(
      "a deploy row is labelled with its server's name",
      before.ok,
      String(before.value),
    );
    await page.evaluate(() => {
      (window as unknown as { __noReload?: boolean }).__noReload = true;
    });
    await db.query(`UPDATE deploy_servers SET name = 'after' WHERE id = $1`, [
      SERVER,
    ]);
    const after = await waitFor(
      () => rowText(page, COMPOSITION),
      (t) => t !== null && t.includes(`${COMPOSITION} on after`),
      { timeoutMs: 30_000 },
    );
    r.ok(
      "a server rename relabels its runs, live",
      after.ok,
      String(after.value),
    );
    await snap(page, OUT, "renamed");

    const noReload = await page.evaluate(
      () => (window as unknown as { __noReload?: boolean }).__noReload === true,
    );
    r.ok("the page never reloaded", noReload);
    await r.finish();
  });
} finally {
  await cleanup();
}
