/**
 * Verification pass for the merged **Runs** surface, driven through the browser.
 *
 * Written because four claims about this surface could not be made from
 * `screenshot.ts`:
 *
 *  1. **The Builds tab.** `screenshot.ts --click "Builds"` hits the Debug
 *     sidebar's own "Builds" nav item — it tries `role=button` before
 *     `radio`/`tab`, and the sidebar entry is a button. Here the tab strip is
 *     addressed by its own role, so the collision cannot happen.
 *  2. **Nested buttons.** A backup row holds two real controls (the disclosure
 *     and, on a failed target, Grant access). Those are only legal because the
 *     backup arm contributes no `link`, so `rowActivation` resolves the row to a
 *     plain container instead of a `<button>`. That is a DOM fact and needs the
 *     DOM to check.
 *  3. **Paging across an arm boundary.** The keyset cursor walks from one
 *     ledger's rows into another's; a duplicated or dropped row shows up only
 *     after scrolling past the boundary.
 *  4. **The pin.** `pinnedView` must render no switcher — a pinned host that
 *     still painted one would let a click there write the shared selection it
 *     ignores.
 *
 * Manual only; nothing runs this automatically. Run it after `./equin
 * build` with:
 *
 *   ./equin run plugins/build/e2e/runs-surface.ts
 *   ./equin run plugins/build/e2e/runs-surface.ts --headed
 *
 * Assertions are written against MARKERS that belong to exactly one run kind,
 * not against row counts off a hand-picked selector: the DataView list exposes
 * no stable row attribute, and a selector guessed from today's markup would
 * turn a future refactor into a false failure.
 *
 *   build   → the namespace chip `att-…` (only builds project a namespace here;
 *             backups and deploys are host-global and read null)
 *   deploy  → `website on <ip>`, the deploy arm's own label
 *   backup  → the `N sources` chip
 */

import type { Page } from "playwright";
import {
  boot,
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { attemptIdKind } from "@plugins/tasks/plugins/task-ids/core";

// `--headed` is read by `withBrowser` itself, so it needs no plumbing here.
const r = report("runs surface");

/** The six tabs `config/runs/runs.jsonc` authors, in the order it authors them. */
const TABS = ["Active", "Recent", "Builds", "Backups", "Shipping", "Failed"];

/**
 * The view switcher's tab for `name`, and nothing else called `name`.
 *
 * The whole reason this script exists. The switcher is built from `ToggleChip`,
 * which renders a plain `<button>` — the same role as the Debug sidebar's
 * same-named nav entries, which is exactly why `screenshot.ts --click "Builds"`
 * lands on the sidebar. Role alone cannot separate them.
 *
 * `aria-pressed` can: `ToggleChip` sets it on every plain-button chip (it defers
 * only when a caller supplies its own role), and a nav item is not a toggle so
 * it carries none. So "a button that reports a pressed state, whose whole label
 * is <name>" is the tab, unambiguously.
 */
function tabChip(page: Page, name: string) {
  return page
    .locator("button[aria-pressed]")
    .filter({ hasText: new RegExp(`^${name}$`) });
}

async function clickTab(page: Page, name: string): Promise<boolean> {
  const tab = tabChip(page, name);
  if ((await tab.count()) === 0) return false;
  await tab.first().click();
  await page.waitForTimeout(1200);
  return true;
}

// A build row's namespace chip is its attempt id — read from the attempt id
// kind, never re-typed here.
const ATTEMPT_NAMESPACE_RE = new RegExp(
  `^(?:${attemptIdKind.recognitionPattern.source})$`,
);

/** How many rows of each kind are on screen, by per-kind marker. */
async function kindCounts(
  page: Page,
): Promise<{ build: number; deploy: number; backup: number }> {
  return {
    build: await page.getByText(ATTEMPT_NAMESPACE_RE).count(),
    deploy: await page.getByText(/website on \d+\.\d+\.\d+\.\d+/).count(),
    backup: await page.getByText(/^\d+ sources$/).count(),
  };
}

/**
 * Buttons that have a button ANCESTOR — invalid HTML, and unreachable by
 * keyboard. Returns each offender's trimmed text so a failure names it.
 */
async function nestedButtons(page: Page): Promise<string[]> {
  return page.$$eval("button", (els) =>
    els
      .filter((el) => el.parentElement?.closest("button") != null)
      .map((el) => (el.textContent ?? "").trim().slice(0, 60)),
  );
}

/**
 * Every absolute timestamp currently rendered — a row's identity for this test.
 *
 * Scraped out of the page's whole text rather than matched against a leaf
 * element: a row renders `7m 08s · 1d ago · 8/27/2026, 5:00:00 AM` as ONE text
 * node, so an anchored per-element match finds nothing (it found nothing, which
 * is how this was caught).
 */
async function rowStamps(page: Page): Promise<string[]> {
  const text = await page.innerText("body");
  return (
    text.match(/\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M/g) ?? []
  );
}

await withBrowser(async (h) => {
  const { page } = await h.session();

  // ---------------------------------------------------------------- /debug/build
  await boot(page, pathUrl("/debug/build"), { settleMs: 3500 });

  // --- the authored tab set, in the authored order -------------------------
  const rendered: string[] = [];
  for (const name of TABS) {
    if ((await tabChip(page, name).count()) > 0) rendered.push(name);
  }
  r.eq("all six authored tabs render", rendered.join(","), TABS.join(","));

  // --- Builds: the tab screenshot.ts could not reach -----------------------
  r.ok("Builds tab is addressable by role", await clickTab(page, "Builds"));
  const builds = await kindCounts(page);
  r.ok(
    "Builds shows at least one build row",
    builds.build > 0,
    `build markers: ${builds.build}`,
  );
  r.eq("Builds shows no deploy rows", builds.deploy, 0);
  r.eq("Builds shows no backup rows", builds.backup, 0);

  // --- Recent: the control the subset claims are measured against ----------
  r.ok("Recent tab is addressable", await clickTab(page, "Recent"));
  const recent = await kindCounts(page);
  r.ok(
    "Recent interleaves build + deploy + backup in one page",
    recent.build > 0 && recent.deploy > 0 && recent.backup > 0,
    `build ${recent.build}, deploy ${recent.deploy}, backup ${recent.backup}`,
  );
  // Only meaningful because Recent (above) proved the other kinds ARE in the
  // window at this instant — a subset claim against an empty control is not one.
  r.ok(
    "…so Builds' exclusions were measured against a populated control",
    recent.deploy > 0 && recent.backup > 0,
  );

  r.eq("no nested buttons on the merged list", await nestedButtons(page), []);

  // --- paging across an arm boundary ---------------------------------------
  // Recent is backup-dominated with a build and two deploys at the head, so the
  // first page already straddles two ledgers and scrolling walks deeper into a
  // third. A duplicated or dropped row is what a mis-seeded cursor produces.
  // The list is VIRTUALIZED, so the on-screen row count cannot grow — the window
  // slides. What grows is the set of DISTINCT rows the surface has served, so
  // that is what is accumulated across scroll steps.
  await page.mouse.move(700, 500); // put the pointer over the list, not the rail
  const firstPage = await rowStamps(page);
  const seen = new Set(firstPage);
  // The invariant is ORDER, not uniqueness. Two backup runs in this ledger share
  // a `started_at` to the second (05/25/2026 09:48:24 — different ids, both
  // `partial`), so "a timestamp appears twice" is a fact about the data, not a
  // defect; an earlier version of this check asserted uniqueness and failed on
  // it. That tie is in fact evidence FOR the keyset: both rows render, once
  // each, which is what `tiebreaker: { fieldId: "id" }` is there to guarantee —
  // an untiebroken cursor drops or repeats one of a tied pair at a page edge.
  //
  // What a mis-seeded cursor really produces is a break in the sort: a page that
  // restarts, or jumps backwards, against `startedAt desc`. That is
  // data-independent, so it is what gets asserted.
  const orderBreaks: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(1000);
    const snapshot = await rowStamps(page);
    for (let j = 1; j < snapshot.length; j++) {
      const prev = Date.parse(snapshot[j - 1]!);
      const cur = Date.parse(snapshot[j]!);
      if (cur > prev) orderBreaks.push(`${snapshot[j - 1]} → ${snapshot[j]}`);
    }
    for (const t of snapshot) seen.add(t);
  }
  r.ok(
    "paging fetches beyond the first page",
    seen.size > firstPage.length,
    `first page ${firstPage.length} distinct → ${seen.size} distinct after scrolling`,
  );
  r.eq(
    "rows stay in startedAt-desc order across the arm boundary",
    orderBreaks,
    [],
  );

  // ---------------------------------------------------------------- backup pane
  // Reached by its sidebar entry: "Backup" (singular) is unambiguous, and the
  // pane's URL is not guessable from the segment alone.
  await page
    .getByRole("button", { name: "Backup", exact: true })
    .first()
    .click();
  await page.waitForTimeout(2500);

  // --- the pin ---------------------------------------------------------------
  // Counted with the SAME locator that finds the tabs on /debug/build — an
  // earlier version of this check asked for `role=radio`, which the switcher
  // never uses, so it passed while proving nothing.
  let switcherTabs = 0;
  for (const name of TABS) switcherTabs += await tabChip(page, name).count();
  r.eq("pinned host paints no view switcher", switcherTabs, 0);

  const pinned = await kindCounts(page);
  r.ok("pinned host shows backup rows", pinned.backup > 0);
  r.eq("pinned host shows no build rows", pinned.build, 0);
  r.eq("pinned host shows no deploy rows", pinned.deploy, 0);

  // --- the two real controls in a backup row ---------------------------------
  r.eq("no nested buttons on the backup panel", await nestedButtons(page), []);

  // The specific defect the per-row-activation work was for, asserted on an
  // ORDINARY row rather than a constructed one: a backup row must resolve to a
  // plain container, because the backup arm contributes no `link`. If it had
  // resolved to a `<button>`, that button would be an ANCESTOR of the row's own
  // disclosure trigger — so "no button ancestor" is exactly the claim, and it is
  // true of all 524 rows rather than of one seeded one.
  const triggers = await page.$$eval("button", (els) =>
    els
      .filter((el) => /^Backup/.test((el.textContent ?? "").trim()))
      .map((el) => ({
        tag: el.tagName,
        ancestor: el.parentElement?.closest("button")?.tagName ?? null,
      })),
  );
  r.ok(
    "backup rows expose a real disclosure button",
    triggers.length > 0,
    `found ${triggers.length}`,
  );
  r.eq(
    "no backup row resolved to a <button> around its own controls",
    triggers.filter((t) => t.ancestor !== null).length,
    0,
  );

  // --- group-by, on the merged surface ------------------------------------
  // Back to the unpinned surface: grouping is a property of the merged space,
  // and `kind` / `outcome` are the two base fields that are supposed to mean the
  // same thing across every arm.
  await page
    .getByRole("button", { name: "Builds", exact: true })
    .first()
    .click();
  await page.waitForTimeout(2000);
  await clickTab(page, "Recent");

  const settings = page.getByRole("button", { name: /View settings/i });
  if ((await settings.count()) === 0) {
    r.fail("View settings control not addressable", "group-by left unverified");
  } else {
    await settings.first().click();
    await page.waitForTimeout(800);
    // Both base fields must be OFFERED as group-by dimensions — that is the
    // schema claim ("filter / sort / group-by mean one thing across kinds"),
    // and it is checkable without depending on how sections render.
    for (const field of ["Kind", "Outcome"]) {
      const option = page.getByRole("radio", { name: field, exact: true });
      const asRow = page
        .locator("[role=radio],[role=menuitemradio],button")
        .filter({
          hasText: new RegExp(`^${field}$`),
        });
      const count = (await option.count()) + (await asRow.count());
      r.ok(`${field} is offered as a group-by dimension`, count > 0);
    }

    // Offered is not the same as working, so actually select one. Grouping wraps
    // the list in collapsible section headers, which is a structural change:
    // `aria-expanded` appears where there was none.
    const before = await page.locator("[aria-expanded]").count();
    const kindRow = page
      .locator("[role=radio],[role=menuitemradio],button")
      .filter({ hasText: /^Kind$/ });
    await kindRow.first().click();
    await page.waitForTimeout(1500);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1200);
    const after = await page.locator("[aria-expanded]").count();
    r.ok(
      "grouping by kind renders collapsible sections",
      after > before,
      `aria-expanded elements ${before} → ${after}`,
    );

    // No teardown here, deliberately. Selecting a grouping above really did
    // mutate the running app — a DataView writes per-instance sort / filter /
    // groupBy straight back through the config layer — but the harness now
    // records every config document an agent-origin request overwrites and
    // restores it at both ends of the run (`e2e/agent-writes.ts`). A
    // hand-written restore here would be discipline standing in for structure,
    // and it never covered a run that was killed before reaching it.
  }

  // Grant access cannot render against this worktree's data — no backup run
  // here carries a failed target with a consent payload — so its ABSENCE is the
  // expected result and is recorded as a gap, never as a pass.
  const grant = await page
    .getByRole("button", { name: "Grant access", exact: true })
    .count();
  r.note(
    grant === 0
      ? "GAP: Grant access not rendered — no run in this worktree has a consent-bearing failed target, so the affordance stays unverified"
      : `Grant access rendered on ${grant} row(s) — verify it is not inside a row button`,
  );
});

await r.finish();
