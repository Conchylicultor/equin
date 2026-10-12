/**
 * The bell's server-side filters, end to end on a deployed build:
 *
 *   1. the boot snapshot carries `notifications` at its default window — the
 *      newest 200 — and a fresh page whose live socket never connects still
 *      paints a settled bell (its unread badge), so the preload alone is enough;
 *   2. a type that appears ONLY outside the newest 200 still has a chip (the
 *      chips are the server's grouping of the whole collection), and picking it
 *      lists every one of its rows (a server-filtered window);
 *   3. scrolling the list to its end grows the window past 200;
 *   4. dismissing a row removes it live, and its chip's count follows;
 *   5. the unread badge counts the WHOLE collection (the `notifications.unread`
 *      value), not the loaded window: 3 unread errors + 250 unread warnings
 *      seeded behind 200 fresh info rows are in the boot snapshot's value, a
 *      page with no live socket paints a red badge whose label reads the exact
 *      total on its FIRST frame (no neutral pending bell ever rendered), and
 *      opening + closing the popover (mark all read) clears it live.
 *
 * WRITES: dismisses every notification in this worktree first (the table is
 * excluded from fork, so these are this worktree's own), seeds 250, dismisses
 * all again and seeds 453 for step 5, and a `finally` dismisses all of them.
 * Step 5 asserts DELTAS over the value read right after its dismiss-all (the
 * server may record its own notifications meanwhile), and reports the baseline.
 *
 * Usage:
 *   ./singularity run plugins/shell/plugins/notifications/e2e/bell-filter.ts [--headed]
 */

import {
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { tapSharedSocket } from "@plugins/primitives/plugins/networking/e2e";
import { openFloatingActionBar } from "@plugins/shell/plugins/global-action-bar/e2e";
import { notificationIdKind } from "@plugins/shell/plugins/notifications/core";
import type { Page } from "playwright";

/** Both live-state sockets (worktree + central). */
const LIVE_SOCKETS = ["/ws/notifications", "/ws/central-notifications"];
const OUT = "/tmp/claude-501/bell-filter";
const r = report("Notifications · bell filters, grouping, boot preload");

const OLD_TYPE = "e2e-old";
const OLD_COUNT = 5;
const BULK_TYPE = "e2e-bulk";
const BULK_COUNT = 245;
const LIVE_TIMEOUT_MS = 10_000;
const UNREAD_ERRORS = 3;
const UNREAD_WARNINGS = 250;
const FRESH_INFO = 200;

type Unread = { errors: number; warnings: number };

// The label carries the exact unread count ("Notifications, 253 unread").
const BELL_LABEL = /^Notifications(, \d+ unread)?$/;
const bell = (page: Page) => page.getByRole("button", { name: BELL_LABEL });
const rows = (page: Page) =>
  page.locator('[data-testid="notification-list"] li');
const chip = (page: Page, type: string) =>
  page.locator(`[data-testid="notification-chips"] [data-type="${type}"]`);

/** Poll a read to a deadline — pushes land asynchronously. */
async function settle<T>(
  page: Page,
  read: () => Promise<T>,
  done: (v: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + LIVE_TIMEOUT_MS;
  let got = await read();
  while (!done(got) && Date.now() < deadline) {
    await page.waitForTimeout(250);
    got = await read();
  }
  return got;
}

await withBrowser(async (h) => {
  const { page, captured } = await h.session();

  const post = async (path: string, data?: unknown) => {
    const res = await page.request.post(pathUrl(path), { data: data ?? {} });
    if (!res.ok()) throw new Error(`POST ${path} — ${res.status()}`);
  };

  try {
    await post("/api/notifications/dismiss-all");
    // Oldest first, one at a time: `createdAt` is the server's now(), so the
    // old type ends up strictly outside the newest 200.
    for (let i = 0; i < OLD_COUNT; i++) {
      await post("/api/notifications", {
        id: notificationIdKind.mint(),
        type: OLD_TYPE,
        title: `${OLD_TYPE} #${i}`,
        description: "seeded by bell-filter.ts",
        variant: "info",
      });
    }
    for (let i = 0; i < BULK_COUNT; i++) {
      await post("/api/notifications", {
        id: notificationIdKind.mint(),
        type: BULK_TYPE,
        title: `${BULK_TYPE} #${i}`,
        description: "seeded by bell-filter.ts",
        // A few unread warnings/errors so the badge (a settled-only paint) shows.
        variant: i % 50 === 0 ? "error" : i % 10 === 0 ? "warning" : "info",
      });
    }
    r.note(
      `seeded ${OLD_COUNT} × ${OLD_TYPE} then ${BULK_COUNT} × ${BULK_TYPE}`,
    );

    // 1 — the boot snapshot holds the default window.
    const snapRes = await page.request.get(
      pathUrl("/api/resources/boot-snapshot"),
    );
    r.ok("boot snapshot answers", snapRes.ok(), `HTTP ${snapRes.status()}`);
    const snapshot = (await snapRes.json()) as {
      resources: Record<string, unknown>;
    };
    const booted = snapshot.resources["notifications"] as
      { type: string }[] | undefined;
    r.ok("boot snapshot includes `notifications`", Array.isArray(booted));
    r.eq("…at the default window's 200 rows", booted?.length, 200);
    r.ok(
      "…which holds none of the old type (it is outside the newest 200)",
      (booted ?? []).every((n) => n.type !== OLD_TYPE),
    );
    r.ok(
      "the :rows / :groups siblings are not preloaded",
      !("notifications:rows" in snapshot.resources) &&
        !("notifications:groups" in snapshot.resources),
    );

    // A page whose live socket never connects: only the preload can settle the bell.
    const offline = await h.session({ label: "no-ws", capture: false });
    // The live sockets never connect (held in their SharedWorker from the
    // start): no sub-ack ever arrives.
    await tapSharedSocket(offline.page, { holdFromStart: LIVE_SOCKETS });
    await boot(offline.page, pathUrl("/"), { settleMs: 1500 });
    const badge = await bell(offline.page)
      .locator("xpath=..")
      .innerText()
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "TimeoutError") return "";
        throw err;
      });
    r.eq(
      "with no live socket the bell still paints settled (unread badge from the boot snapshot)",
      badge.trim(),
      "9+",
    );
    await snap(offline.page, OUT, "1-bell-no-ws");
    await offline.context.close();

    // 2 — the old type's chip, and its full list.
    await boot(page, pathUrl("/"), { settleMs: 1500 });
    await page.evaluate(() => {
      Object.assign(window, { __e2eBell: true });
    });
    await openFloatingActionBar(page);
    await bell(page).click();
    await page
      .locator('[data-testid="notification-chips"] button')
      .first()
      .waitFor({ timeout: LIVE_TIMEOUT_MS });
    r.eq("the All window lists the newest 200", await rows(page).count(), 200);
    r.ok("the old type has a chip", (await chip(page, OLD_TYPE).count()) === 1);
    r.eq(
      "…showing its whole-collection count",
      (await chip(page, OLD_TYPE).innerText()).replace(/\s+/g, ""),
      `E2e-old${OLD_COUNT}`,
    );
    await chip(page, OLD_TYPE).click();
    const oldCount = await settle(
      page,
      () => rows(page).count(),
      (n) => n === OLD_COUNT,
    );
    r.eq("picking it lists every one of its rows", oldCount, OLD_COUNT);
    await snap(page, OUT, "2-old-type-chip");

    // 4 — dismiss one: it leaves the list and the chip count follows.
    await rows(page).first().getByRole("button", { name: "Dismiss" }).click();
    r.eq(
      "a dismissed row leaves the filtered list live",
      await settle(
        page,
        () => rows(page).count(),
        (n) => n === OLD_COUNT - 1,
      ),
      OLD_COUNT - 1,
    );
    r.ok(
      "…and the chip's count drops",
      (
        await settle(
          page,
          () => chip(page, OLD_TYPE).innerText(),
          (t) => t.includes(String(OLD_COUNT - 1)),
        )
      ).includes(String(OLD_COUNT - 1)),
    );

    // 3 — the bulk type's window grows past 200 on scroll.
    await chip(page, BULK_TYPE).click();
    r.eq(
      "the bulk filter opens at its default 200",
      await settle(
        page,
        () => rows(page).count(),
        (n) => n === 200,
      ),
      200,
    );
    const scrollToEnd = () =>
      page.locator('[data-testid="notification-list"]').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
    await scrollToEnd();
    const grown = await settle(
      page,
      async () => {
        await scrollToEnd();
        return rows(page).count();
      },
      (n) => n === BULK_COUNT,
    );
    r.eq(
      "scrolling to the end grows the window to every row",
      grown,
      BULK_COUNT,
    );
    await snap(page, OUT, "3-grown");

    r.ok(
      "nothing reloaded the page",
      await page.evaluate(() => Reflect.get(window, "__e2eBell") === true),
    );

    // 5 — the badge counts the whole collection, not the window.
    await page.keyboard.press("Escape");
    await post("/api/notifications/dismiss-all");
    const readSnapshot = async () => {
      const res = await page.request.get(
        pathUrl("/api/resources/boot-snapshot"),
      );
      if (!res.ok()) throw new Error(`boot snapshot — HTTP ${res.status()}`);
      return ((await res.json()) as { resources: Record<string, unknown> })
        .resources;
    };
    const baseline = (await readSnapshot())["notifications.unread"] as
      Unread | undefined;
    if (baseline === undefined) {
      throw new Error("boot snapshot has no `notifications.unread`");
    }
    r.note(`unread baseline after dismiss-all: ${JSON.stringify(baseline)}`);
    // Oldest first: the counted rows end up strictly behind the fresh info rows.
    const seedN = async (n: number, variant: string, tag: string) => {
      for (let i = 0; i < n; i++) {
        await post("/api/notifications", {
          id: notificationIdKind.mint(),
          type: `e2e-${tag}`,
          title: `${tag} #${i}`,
          description: "seeded by bell-filter.ts (unread badge)",
          variant,
        });
      }
    };
    await seedN(UNREAD_ERRORS, "error", "unread-error");
    await seedN(UNREAD_WARNINGS, "warning", "unread-warning");
    await seedN(FRESH_INFO, "info", "fresh-info");
    r.note(
      `seeded ${UNREAD_ERRORS} errors + ${UNREAD_WARNINGS} warnings behind ${FRESH_INFO} info rows`,
    );

    const resources = await readSnapshot();
    const expected: Unread = {
      errors: baseline.errors + UNREAD_ERRORS,
      warnings: baseline.warnings + UNREAD_WARNINGS,
    };
    r.eq(
      "boot snapshot `notifications.unread` = baseline + {errors: 3, warnings: 250}",
      resources["notifications.unread"],
      expected,
    );
    const window5 = resources["notifications"] as { variant: string }[];
    r.ok(
      "…while the preloaded window holds none of them (all 200 are the fresh info rows)",
      window5.length === 200 && window5.every((n) => n.variant === "info"),
    );
    const total = expected.errors + expected.warnings;
    const exactLabel = `Notifications, ${total} unread`;

    // No live socket, and every bell label ever rendered recorded from the
    // document's start: the first frame must already be the settled count.
    const noWs = await h.session({ label: "no-ws-unread", capture: false });
    // The live sockets never connect (held in their SharedWorker from the
    // start): no sub-ack ever arrives.
    await tapSharedSocket(noWs.page, { holdFromStart: LIVE_SOCKETS });
    await noWs.page.addInitScript(() => {
      const seen: string[] = [];
      Object.assign(window, { __bellLabels: seen });
      const record = () => {
        for (const el of document.querySelectorAll(
          'button[aria-label^="Notifications"]',
        )) {
          const label = el.getAttribute("aria-label") ?? "";
          if (seen[seen.length - 1] !== label) seen.push(label);
        }
      };
      new MutationObserver(record).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["aria-label"],
      });
    });
    await boot(noWs.page, pathUrl("/"), { settleMs: 1500 });
    // The bell mounts seconds after boot settles on a loaded host: wait for
    // the settled label, then read every label recorded on the way there.
    await noWs.page
      .getByRole("button", { name: exactLabel })
      .waitFor({ timeout: LIVE_TIMEOUT_MS })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "TimeoutError") return;
        throw err;
      });
    const labels = (await noWs.page.evaluate(() =>
      Reflect.get(window, "__bellLabels"),
    )) as string[];
    r.eq(
      "with no live socket every bell frame reads the exact total (no pending frame)",
      labels,
      [exactLabel],
    );
    const badge5 = noWs.page
      .getByRole("button", { name: exactLabel })
      .locator("xpath=..");
    r.eq("…its badge shows 9+", (await badge5.innerText()).trim(), "9+");
    r.ok(
      "…in red (an error is among them)",
      (await badge5.locator(".bg-destructive-solid").count()) === 1,
    );
    await snap(noWs.page, OUT, "5-unread-no-ws");
    await noWs.context.close();

    // Open + close the popover on the live page: mark all read clears the badge.
    await boot(page, pathUrl("/"), { settleMs: 1500 });
    r.eq(
      "the live page's bell reads the exact total",
      await settle(
        page,
        () => bell(page).getAttribute("aria-label"),
        (l) => l === exactLabel,
      ),
      exactLabel,
    );
    await openFloatingActionBar(page);
    await bell(page).click();
    await page
      .locator('[data-testid="notification-list"]')
      .waitFor({ timeout: LIVE_TIMEOUT_MS });
    await page.keyboard.press("Escape");
    r.eq(
      "closing the popover marks all read and the badge clears live",
      await settle(
        page,
        () => bell(page).getAttribute("aria-label"),
        (l) => l === "Notifications",
      ),
      "Notifications",
    );
    await snap(page, OUT, "5-unread-cleared");
  } finally {
    const res = await page.request.post(
      pathUrl("/api/notifications/dismiss-all"),
      { data: {} },
    );
    r.ok(
      "cleanup dismissed every notification",
      res.ok(),
      `HTTP ${res.status()}`,
    );
  }

  r.ok(
    "no uncaught page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
});

await r.finish();
