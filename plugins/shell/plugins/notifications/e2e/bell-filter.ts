/**
 * The bell's popover, end to end on a deployed build:
 *
 *   1. the boot snapshot carries `notifications` at its default window — the
 *      newest 200 — and a fresh page whose live socket never connects still
 *      paints a settled bell (its unread badge), so the preload alone is enough;
 *   2. the chips are by CATEGORY (All · Errors · Conversations · Updates ·
 *      Automations, + Reports / Other only while non-empty), counted over the
 *      whole collection: a category that appears ONLY outside the newest 200
 *      still has its count, and picking it lists exactly that many rows, all of
 *      it; the Errors chip lists the error rows only, its count matching;
 *   3. scrolling a picked category's list to its end grows the window past 200;
 *   4. "View all" opens Debug → Notifications (the whole collection as a
 *      DataView) and closes the popover WITHOUT marking all read (the badge
 *      keeps its count); the pane's search finds the old category's rows, and
 *      its Dismiss item action removes one live — the popover's chip follows;
 *   4b. the popover's "Mark all read" icon button clears the badge live;
 *   4c. clicking a row itself (not its Open button) opens its action's target
 *      and closes the popover;
 *   5. the unread badge counts the WHOLE collection (the `notifications.unread`
 *      value), not the loaded window: 3 unread errors + 250 unread warnings
 *      seeded behind 200 fresh info rows are in the boot snapshot's value, a
 *      page with no live socket paints a red badge whose label reads the exact
 *      total on its FIRST frame (no neutral pending bell ever rendered), and
 *      opening + closing the popover (mark all read) clears it live.
 *
 * WRITES: dismisses every notification in this worktree first (the table is
 * excluded from fork, so these are this worktree's own), seeds 251, dismisses
 * all again and seeds 453 for step 5, and a `finally` dismisses all of them.
 * Step 5 asserts DELTAS over the value read right after its dismiss-all (the
 * server may record its own notifications meanwhile), and reports the baseline.
 *
 * Usage:
 *   ./equin run plugins/shell/plugins/notifications/e2e/bell-filter.ts [--headed]
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
import {
  notificationIdKind,
  notificationsRoute,
} from "@plugins/shell/plugins/notifications/core";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import type { Page } from "playwright";
import { AUDIENCES, type Audience } from "@plugins/audience/core";

/** Both live-state sockets (worktree + central). */
const LIVE_SOCKETS = ["/ws/notifications", "/ws/central-notifications"];
const OUT = "/tmp/claude-501/bell-filter";
const r = report("Notifications · bell filters, grouping, boot preload");

// Categories no host producer writes in a worktree under e2e, so the counts
// are the seeded ones.
const OLD_CATEGORY = "automations";
const OLD_TITLE = "e2e old";
const OLD_COUNT = 5;
const BULK_CATEGORY = "updates";
const BULK_COUNT = 245;
/** i % 50 === 0 over the bulk rows. */
const BULK_ERRORS = 5;
const LIVE_TIMEOUT_MS = 10_000;
/** Where the `other` row's `open` action goes (step 4c). */
const OPEN_TARGET = notificationsRoute.link(debugApp, {});
const UNREAD_ERRORS = 3;
const UNREAD_WARNINGS = 250;
const FRESH_INFO = 200;

type Counts = { errors: number; warnings: number };
/** `notifications.unread`: one count per audience; the bell shows its reader's. */
type Unread = Record<Audience, Counts>;

// The label carries the exact unread count ("Notifications, 253 unread").
const BELL_LABEL = /^Notifications(, \d+ unread)?$/;
// The bell names itself with `aria-label`; Debug's "Notifications" sidebar row
// (the View all pane) is named by its text, so it never matches.
const bell = (page: Page) =>
  page
    .getByRole("button", { name: BELL_LABEL })
    .and(page.locator("[aria-label]"));
const rows = (page: Page) =>
  page.locator('[data-testid="notification-list"] li');

/** The count a bell label carries (0 when it names none). */
const unreadOf = (label: string | null) =>
  Number(/, (\d+) unread$/.exec(label ?? "")?.[1] ?? 0);

const chips = (page: Page) =>
  page.locator('[data-testid="notification-chips"] button');
const chip = (page: Page, category: string) =>
  page.locator(
    `[data-testid="notification-chips"] [data-category="${category}"]`,
  );
const errorsChip = (page: Page) => chips(page).filter({ hasText: /^Errors/ });
/** Every chip's label, count stripped (`Updates 245` → `Updates`). */
const chipLabels = async (page: Page) =>
  (await chips(page).allInnerTexts()).map((t) =>
    t.replace(/[\s\d]+$/, "").trim(),
  );
/** A chip's count — a category's, or the Errors chip's (`null`). */
const chipCount = async (page: Page, category: string | null) => {
  const text = await (
    category === null ? errorsChip(page) : chip(page, category)
  ).innerText();
  const m = /(\d+)\s*$/.exec(text);
  if (m === null) throw new Error(`chip "${text}" carries no count`);
  return Number(m[1]);
};

/** Open the bell's popover and wait for its chips. */
async function openBell(page: Page) {
  await openFloatingActionBar(page);
  await bell(page).click();
  await chips(page).first().waitFor({ timeout: LIVE_TIMEOUT_MS });
}

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
    // old category ends up strictly outside the newest 200.
    for (let i = 0; i < OLD_COUNT; i++) {
      await post("/api/notifications", {
        id: notificationIdKind.mint(),
        type: "e2e-old",
        category: OLD_CATEGORY,
        title: `${OLD_TITLE} #${i}`,
        description: "seeded by bell-filter.ts",
        variant: "info",
      });
    }
    // One `other` row: the conditional chip shows once it holds anything.
    // It opens the e2e target (step 4c: the row itself is the link).
    await post("/api/notifications", {
      id: notificationIdKind.mint(),
      type: "e2e-other",
      category: "other",
      title: "e2e other",
      description: "seeded by bell-filter.ts",
      variant: "info",
      action: { kind: "open", payload: { to: OPEN_TARGET } },
    });
    for (let i = 0; i < BULK_COUNT; i++) {
      await post("/api/notifications", {
        id: notificationIdKind.mint(),
        type: "e2e-bulk",
        category: BULK_CATEGORY,
        title: `e2e bulk #${i}`,
        description: "seeded by bell-filter.ts",
        // A few unread warnings/errors so the badge (a settled-only paint) shows.
        variant: i % 50 === 0 ? "error" : i % 10 === 0 ? "warning" : "info",
      });
    }
    r.note(
      `seeded ${OLD_COUNT} × ${OLD_CATEGORY}, 1 × other, then ${BULK_COUNT} × ${BULK_CATEGORY}`,
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
      { category: string }[] | undefined;
    r.ok("boot snapshot includes `notifications`", Array.isArray(booted));
    r.eq("…at the default window's 200 rows", booted?.length, 200);
    r.ok(
      "…which holds none of the old category (it is outside the newest 200)",
      (booted ?? []).every((n) => n.category !== OLD_CATEGORY),
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

    // 2 — the category chips.
    await boot(page, pathUrl("/"), { settleMs: 1500 });
    await page.evaluate(() => {
      Object.assign(window, { __e2eBell: true });
    });
    await openBell(page);
    r.eq("the All window lists the newest 200", await rows(page).count(), 200);
    // A report the host files meanwhile (a slow-op under e2e load) adds Reports.
    const labels2 = (await chipLabels(page))
      .filter((l) => l !== "Reports")
      .join(" · ");
    r.eq(
      "the chips are All · Errors · Conversations · Updates · Automations, then the non-empty Other",
      labels2,
      "All · Errors · Conversations · Updates · Automations · Other",
    );
    r.eq(
      "the old category's chip shows its whole-collection count",
      await chipCount(page, OLD_CATEGORY),
      OLD_COUNT,
    );
    await chip(page, OLD_CATEGORY).click();
    const oldCount = await settle(
      page,
      () => rows(page).count(),
      (n) => n === OLD_COUNT,
    );
    r.eq("picking it lists every one of its rows", oldCount, OLD_COUNT);
    r.ok(
      "…and only its rows",
      (await rows(page).allInnerTexts()).every((t) => t.includes(OLD_TITLE)),
    );
    await snap(page, OUT, "2-old-category-chip");

    // Errors: the error rows only, as many as its count.
    await errorsChip(page).click();
    const errorCount = await chipCount(page, null);
    const errorRows = await settle(
      page,
      () => rows(page).count(),
      (n) => n === errorCount,
    );
    r.eq(
      "the Errors chip lists as many rows as its count",
      errorRows,
      errorCount,
    );
    r.ok(
      "…the seeded errors among them, every row an error",
      errorCount >= BULK_ERRORS &&
        (await rows(page).evaluateAll((lis) =>
          lis.every(
            (li) =>
              li.querySelector("[data-notification-view] .text-destructive") !==
              null,
          ),
        )),
      `${errorCount} errors`,
    );
    await snap(page, OUT, "2-errors-chip");

    // 3 — the bulk category's window grows past 200 on scroll.
    await chip(page, BULK_CATEGORY).click();
    r.eq(
      "the bulk category opens at its default 200",
      await settle(
        page,
        () => rows(page).count(),
        (n) => n === 200,
      ),
      200,
    );
    r.eq(
      "…its chip counting all of them",
      await chipCount(page, BULK_CATEGORY),
      BULK_COUNT,
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

    // 4 — View all: the pane, and leaving through it marks nothing read.
    const labelBefore = await bell(page).getAttribute("aria-label");
    await page.getByRole("button", { name: "View all" }).click();
    await page.waitForURL(/\/debug\/notifications(\?|$)/, {
      timeout: LIVE_TIMEOUT_MS,
    });
    r.ok("View all opens Debug → Notifications", true, page.url());
    r.eq(
      "…and closes the popover",
      await page.locator('[data-testid="notification-list"]').count(),
      0,
    );
    const paneRows = page.locator(
      "[data-row-key]:not([data-page-placeholder])",
    );
    r.ok(
      "the pane lists notifications",
      (await settle(
        page,
        () => paneRows.count(),
        (n) => n > 0,
      )) > 0,
    );
    await page.getByPlaceholder("Search notifications…").fill(OLD_TITLE);
    r.eq(
      "its search finds the old category's rows",
      await settle(
        page,
        () => paneRows.count(),
        (n) => n === OLD_COUNT,
      ),
      OLD_COUNT,
    );
    await snap(page, OUT, "4-view-all-pane");
    // Mark-all-read would land within a push; give it the same deadline.
    await page.waitForTimeout(1500);
    const labelAfter = await bell(page).getAttribute("aria-label");
    r.ok(
      "leaving through View all did not mark all read (the badge kept its count)",
      unreadOf(labelAfter) >= unreadOf(labelBefore) &&
        unreadOf(labelBefore) > 0,
      `${labelBefore} → ${labelAfter}`,
    );

    // Dismiss is the pane's item action now (the popover's rows have none).
    const firstPaneRow = paneRows.first();
    await firstPaneRow.hover();
    await firstPaneRow.getByRole("button", { name: "Dismiss" }).click();
    r.eq(
      "the pane's Dismiss removes the row live",
      await settle(
        page,
        () => paneRows.count(),
        (n) => n === OLD_COUNT - 1,
      ),
      OLD_COUNT - 1,
    );
    await snap(page, OUT, "4-dismissed");
    await openBell(page);
    r.eq(
      "…and the popover's chip count follows",
      await settle(
        page,
        () => chipCount(page, OLD_CATEGORY),
        (n) => n === OLD_COUNT - 1,
      ),
      OLD_COUNT - 1,
    );
    r.eq(
      "the popover's rows carry no per-row Dismiss",
      await page
        .locator('[data-testid="notification-list"]')
        .getByRole("button", { name: "Dismiss" })
        .count(),
      0,
    );

    // 4b — the header's Mark all read icon button clears the badge live.
    r.ok(
      "the badge still has unread items before Mark all read",
      unreadOf(await bell(page).getAttribute("aria-label")) > 0,
    );
    await page.locator('button[aria-label="Mark all read"]').click();
    r.eq(
      "the popover's Mark all read clears the badge live",
      await settle(
        page,
        () => bell(page).getAttribute("aria-label"),
        (l) => l === "Notifications",
      ),
      "Notifications",
    );
    await snap(page, OUT, "4b-marked-read");

    // 4c — clicking a row (not its button) opens its action's target and
    // closes the popover.
    await boot(page, pathUrl("/"), { settleMs: 1500 });
    await openBell(page);
    await chip(page, "other").click();
    const otherRow = rows(page).filter({ hasText: "e2e other" });
    await otherRow.waitFor({ timeout: LIVE_TIMEOUT_MS });
    // The row's headline, away from its Open button.
    await otherRow.getByText("e2e other", { exact: true }).click();
    await page.waitForURL(/\/debug\/notifications(\?|$)/, {
      timeout: LIVE_TIMEOUT_MS,
    });
    r.ok("clicking a row opens its action's target", true, page.url());
    r.eq(
      "…and closes the popover",
      await page.locator('[data-testid="notification-list"]').count(),
      0,
    );
    await snap(page, OUT, "4c-row-opened");
    // Leave the Debug pane: step 5 seeds 453 rows, and a live DataView of the
    // whole collection re-rendering under every insert stalls the page.
    await boot(page, pathUrl("/"), { settleMs: 1500 });

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
          category: "other",
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
    // Every seeded row is for everyone, so it counts for each audience.
    const expected = Object.fromEntries(
      AUDIENCES.map((a) => [
        a,
        {
          errors: baseline[a].errors + UNREAD_ERRORS,
          warnings: baseline[a].warnings + UNREAD_WARNINGS,
        },
      ]),
    ) as Unread;
    r.eq(
      "boot snapshot `notifications.unread` = baseline + {errors: 3, warnings: 250}, per audience",
      resources["notifications.unread"],
      expected,
    );
    const window5 = resources["notifications"] as { variant: string }[];
    r.ok(
      "…while the preloaded window holds none of them (all 200 are the fresh info rows)",
      window5.length === 200 && window5.every((n) => n.variant === "info"),
    );
    // The reader's audience (Developer mode) is the user's config, not the
    // script's: the bell must read ONE audience's exact total, whichever.
    const exactLabels = new Set(
      AUDIENCES.map(
        (a) =>
          `Notifications, ${expected[a].errors + expected[a].warnings} unread`,
      ),
    );
    // Letters, digits, a comma and spaces: no regex metacharacter to escape.
    const anyExact = new RegExp(`^(${[...exactLabels].join("|")})$`);

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
      .getByRole("button", { name: anyExact })
      .waitFor({ timeout: LIVE_TIMEOUT_MS })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "TimeoutError") return;
        throw err;
      });
    const labels = (await noWs.page.evaluate(() =>
      Reflect.get(window, "__bellLabels"),
    )) as string[];
    const exactLabel = labels[0] ?? "";
    r.ok(
      "with no live socket every bell frame reads the exact total (no pending frame)",
      labels.length === 1 && exactLabels.has(exactLabel),
      `${JSON.stringify(labels)} vs ${JSON.stringify([...exactLabels])}`,
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
    await openBell(page);
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
