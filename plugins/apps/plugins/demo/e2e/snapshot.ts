/**
 * The demo starts from the snapshot its build took (design: the wiki page
 * "Design: a browser host's data kept in browser storage", "A starting
 * snapshot, built at build time"). In `/demo`, in one fresh browser context
 * (so its IndexedDB starts empty), it:
 *
 *  1. opens the demo: the worker boots on the build's snapshot (its boot line
 *     says `data: snapshot`) — no seed runs in the browser (it reports no
 *     `seed` stage) — and the story is there (the seeded pages are listed);
 *  2. creates a page, closes the demo, and reopens it: the page is kept, and
 *     the worker boots on what is stored (`data: stored`), not the snapshot;
 *  3. makes the stored data read as started from an older build's snapshot
 *     (the lifecycle record rewritten while no worker holds it), and opens the
 *     demo again: the data is reset to this build's snapshot — the created
 *     page is gone, the seeded ones are back — silently: an update just
 *     starts on the fresh data, with no notice.
 *
 * And, throughout: the page stays on the demo, no page error, no console error.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/demo/e2e/snapshot.ts [--out /tmp/demo-snapshot] [--headed]
 */
import type { Page } from "playwright";
import {
  arg,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
  type Report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  AGENT_MANAGER_LOCATION,
  backdateStoredSnapshot,
  createPage,
  demoPath,
  listed,
  MARKER,
  onDemoPage,
  openPages,
  RENDER_TIMEOUT_MS,
  ROOT_PAGES,
  settledCount,
  waitForStorageReleased,
  bootDemo,
} from "./internal/demo-pages";

const OUT = arg("out") ?? "/tmp/demo-snapshot";

/** What the demo tells a visitor whose older data was replaced (`bin/browser-host.ts`). */

/** Where the boot line says the host's data came from (`data: <origin>;`). */
const dataOf = (line: string | null): string | null =>
  line === null ? null : (/; data: ([^;]+);/.exec(line)?.[1] ?? null);

/**
 * Open the demo in `page` and wait for its host's boot line (DemoScope logs
 * one per boot it waited for); returns that line.
 */
async function openDemo(
  r: Report,
  page: Page,
  step: string,
): Promise<string | null> {
  const lines: string[] = [];
  const onConsole = (m: { text(): string }) => {
    if (m.text().startsWith("[demo-scope]")) lines.push(m.text());
  };
  page.on("console", onConsole);
  await bootDemo(page, pathUrl(demoPath(AGENT_MANAGER_LOCATION)), {
    marker: MARKER,
  });
  const settled = await waitFor(
    async () => lines.at(-1) ?? null,
    (line) => line !== null,
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  page.off("console", onConsole);
  r.ok(`${step}: the host reported its boot`, settled.ok, settled.value ?? "");
  return settled.value;
}

await withBrowser(async (h) => {
  const r = report("demo: a fresh visit starts from the build's snapshot");
  const { page, context } = await h.session();
  const stamp = Date.now().toString(36);
  const CREATED = `Mine ${stamp}`;

  // ── 1. a fresh visit loads the snapshot; no seed runs ──────────────────
  const t0 = Date.now();
  const first = await openDemo(r, page, "first visit");
  r.eq(
    "first visit: the worker booted on the build's snapshot",
    dataOf(first),
    "snapshot",
  );
  r.ok(
    "first visit: no seed ran in the browser (the boot reports no seed stage)",
    first !== null && !/\bseed \d+ ms/.test(first),
    first ?? "",
  );
  console.info(`first visit: demo ready after ${Date.now() - t0} ms`);
  await openPages(r, page, "first visit");
  const seeded = new Map<string, number>();
  for (const title of ROOT_PAGES) {
    seeded.set(
      title,
      await settledCount(r, page, `the snapshot lists "${title}"`, title),
    );
  }
  await createPage(page, CREATED);
  await listed(r, page, "the created page is listed", CREATED, "some");
  await snap(page, OUT, "1-first-visit");

  // ── 2. reopened: kept, no second fetch ─────────────────────────────────
  // A page of the origin that does not open the demo: the storage's lock is
  // read from here while no tab holds the demo.
  const outside = await context.newPage();
  await outside.goto(pathUrl("/api/health"));
  await page.close();
  await waitForStorageReleased(
    r,
    outside,
    "closed: the worker released the demo's storage",
  );
  const second = await context.newPage();
  const reopened = await openDemo(r, second, "reopened");
  await openPages(r, second, "reopened");
  await listed(
    r,
    second,
    "reopened: the created page is kept",
    CREATED,
    "some",
  );
  r.eq(
    "reopened: the worker booted on the stored data",
    dataOf(reopened),
    "stored",
  );

  // ── 3. data from an older snapshot is reset, with no notice ───────────
  await second.close();
  await waitForStorageReleased(
    r,
    outside,
    "closed again: the worker released the demo's storage",
  );
  const was = await backdateStoredSnapshot(outside);
  r.ok("the stored data named the build's snapshot", was.length > 0, was);
  const third = await context.newPage();
  const t1 = Date.now();
  const replaced = await openDemo(r, third, "after a newer build");
  console.info(
    `reset to the new snapshot: demo ready after ${Date.now() - t1} ms`,
  );
  r.eq(
    "after a newer build: the worker replaced the data with this build's snapshot",
    dataOf(replaced),
    "snapshot (replacing data from an older one)",
  );
  r.eq(
    "the update says nothing: no notice over the demo",
    await third.getByText(/The demo was updated/).count(),
    0,
  );
  await snap(third, OUT, "3-reset-silently");
  await openPages(r, third, "after a newer build");
  for (const title of ROOT_PAGES) {
    await listed(
      r,
      third,
      `after a newer build, "${title}" is listed as on the first visit`,
      title,
      seeded.get(title)!,
    );
  }
  await listed(
    r,
    third,
    "after a newer build, the created page is gone",
    CREATED,
    0,
  );
  r.ok("the page stays on the demo", onDemoPage(third.url()), third.url());
  await r.finish();
});
