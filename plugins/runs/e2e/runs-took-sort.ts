/**
 * Proves "Took" is a clock field on the deployed `runs` union window (item 7
 * session 2 of research/2026-11-03-global-live-collections-item7-remaining.md):
 *
 *  1. sorted by Took, an IN-FLIGHT run sorts by how long it has been going —
 *     in both directions — not last (before: its duration was NULL, so it sat
 *     last either way). Read through the window resource itself, at a pinned
 *     `now` (the minute, as `useLive` pins it), over three seeded backups: one
 *     that took 20 min, one running for 10, one that took 5;
 *  2. the server refuses that query without its pin (a clock read with no
 *     `now`), and no row carries the field — the browser computes it;
 *  3. the browser draws the running run's Took from its own clock: it reads
 *     ~10 minutes and ticks.
 *
 * Seeded rows are deleted at the end (also on failure). Refuses main.
 *
 *   ./equin run plugins/runs/e2e/runs-took-sort.ts [--headed]
 */
import { randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { pinNow } from "@plugins/network/plugins/live/core";
import {
  agentFetch,
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
import { runs } from "@plugins/runs/core";

const OUT = arg("out") ?? "/tmp/runs-took-sort";
const MINUTE = 60_000;
const db = openDeployDb();
const tag = `e2e-${randomBytes(3).toString("hex")}`;
const LONG = `${tag}-long`; // finished, took 20 min
const RUNNING = `${tag}-running`; // in flight for 10 min
const SHORT = `${tag}-short`; // finished, took 5 min

let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  await db.query("DELETE FROM backup_runs WHERE id = ANY($1)", [
    [LONG, RUNNING, SHORT],
  ]);
  await db.close();
}
onBeforeFinish(cleanup);

/** The `runs` window at these params, as the server answers it. */
async function window(
  params: Record<string, string>,
): Promise<{ status: number; rows: Record<string, unknown>[] }> {
  const res = await agentFetch(
    `/api/resources/runs?${new URLSearchParams(params).toString()}`,
  );
  if (!res.ok) return { status: res.status, rows: [] };
  const body = (await res.json()) as { value: Record<string, unknown>[] };
  return { status: res.status, rows: body.value };
}

const ids = (rows: readonly Record<string, unknown>[]) => rows.map((r) => r.id);

/** The text of the list row showing `needle` (see runs-live.ts), or null. */
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
    `INSERT INTO backup_runs (id, trigger, started_at, finished_at, status) VALUES
       ($1, $1, now() - interval '60 minutes', now() - interval '40 minutes', 'ok'),
       ($2, $2, now() - interval '10 minutes', NULL, 'running'),
       ($3, $3, now() - interval '30 minutes', now() - interval '25 minutes', 'ok')`,
    [LONG, RUNNING, SHORT],
  );

  const r = report("Runs · Took is a clock field: in-flight runs sort by it");
  const codec = runs.window.window;
  const now = pinNow(Date.now(), MINUTE);
  // Each seeded run's trigger is its id, so the rows are found by it.
  const where = { trigger: { in: [LONG, RUNNING, SHORT] } };

  // 1. Sorted by Took, both directions, at a pinned minute.
  const desc = await window(
    codec.encode({ where, orderBy: [["duration", "desc"]], now }),
  );
  r.ok(
    "Took desc: 20 min, running 10 min, 5 min",
    JSON.stringify(ids(desc.rows)) === JSON.stringify([LONG, RUNNING, SHORT]),
    `${desc.status} ${JSON.stringify(ids(desc.rows))}`,
  );
  const asc = await window(
    codec.encode({ where, orderBy: [["duration", "asc"]], now }),
  );
  r.ok(
    "Took asc: 5 min, running 10 min, 20 min — the running run is not last",
    JSON.stringify(ids(asc.rows)) === JSON.stringify([SHORT, RUNNING, LONG]),
    `${asc.status} ${JSON.stringify(ids(asc.rows))}`,
  );
  const filtered = await window(
    codec.encode({ where: { ...where, duration: { gt: 8 * MINUTE } }, now }),
  );
  r.ok(
    "filtered Took > 8 min: the running run matches by its elapsed time",
    JSON.stringify([...ids(filtered.rows)].sort()) ===
      JSON.stringify([LONG, RUNNING].sort()),
    JSON.stringify(ids(filtered.rows)),
  );

  // 2. No pin, no answer; no row carries the field.
  const pinned = codec.encode({ where, orderBy: [["duration", "desc"]], now });
  const unpinned: Record<string, string> = { ...pinned };
  delete unpinned.now;
  const refused = await window(unpinned);
  r.ok(
    "the same query without its pinned `now` is refused",
    refused.status >= 400 && refused.status < 500,
    String(refused.status),
  );
  r.ok(
    "no row carries Took (the browser computes it)",
    desc.rows.length > 0 && desc.rows.every((row) => !("duration" in row)),
  );

  // 3. The browser computes the running run's Took from its own clock.
  await withBrowser(async (h) => {
    const { page } = await h.session({
      viewport: { width: 1600, height: 900 },
    });
    await boot(page, pathUrl("/debug/backup"), {
      marker: '[data-ui-owner^="ListView@"]',
      timeoutMs: 120_000,
      settleMs: 1000,
    });
    const first = await waitFor(
      () => rowText(page, RUNNING),
      (t) => t !== null,
      { timeoutMs: 60_000 },
    );
    r.ok(
      "the running backup's Took reads ~10 minutes",
      first.ok && /10m/.test(String(first.value)),
      String(first.value),
    );
    await page.waitForTimeout(2500);
    const later = await rowText(page, RUNNING);
    r.ok(
      "and ticks on the client",
      later !== null && later !== first.value,
      `${String(first.value)} → ${String(later)}`,
    );
    await snap(page, OUT, "running");
    await r.finish();
  });
} finally {
  await cleanup();
}
