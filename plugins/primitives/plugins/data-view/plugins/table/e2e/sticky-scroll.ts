/**
 * Verifies the grid table's sticky first column and sideways scroll — on the
 * Studio explorer's nested "Table" view and on a flat table (Debug → Claude
 * CLI Calls) — at 390 / 820 / 1440 wide, light and dark.
 *
 * At each width it captures the table, then — when the table is wider than
 * its box (the grid marks its box `data-scrolls-x`, which turns the pane into
 * the sideways scroller) — scrolls the pane right and asserts:
 *
 * - the first column (header label and every body cell) stays at the
 *   scroller's left edge while a later column moved by the scroll;
 * - the first cell is opaque, so the columns scrolling under it never show;
 * - the DataView's toolbar band stays where it was, inside the visible width;
 * - every other child of the pane (the explorer's stats band) stays put too:
 *   only the table moves.
 *
 * A width where everything fits asserts nothing scrolls instead. A table in a
 * card with no scroller of its own (a deployment's History "All" table, a
 * detail section) never goes wide: it squeezes into the card at every
 * width, nothing pinned, nothing scrolling sideways.
 *
 * Manual only. Run after `./singularity build`:
 *   ./singularity run plugins/primitives/plugins/data-view/plugins/table/e2e/sticky-scroll.ts \
 *     [--out /tmp/sticky-scroll] [--headed]
 */
import type { Page } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
  type Report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/sticky-scroll";
const WIDTHS = [390, 820, 1440];
const SCHEMES = ["light", "dark"] as const;

interface Surface {
  name: string;
  path: string;
  /** A table in a card: it must squeeze, never scroll the pane sideways. */
  squeezes?: true;
  /** Switch to the view to verify, once the page painted. */
  open: (page: Page) => Promise<void>;
}

const SURFACES: Surface[] = [
  {
    name: "explorer",
    path: "/studio/explorer",
    open: async (page) => {
      // By name: the "Tree" view is an (outline) table too.
      await page
        .locator("[data-view-type='table']", { hasText: "Table" })
        .first()
        .click();
      // Open one root so the nesting is in the picture.
      const parent = page
        .locator("[role='treegrid'] [data-tree-row][aria-expanded='false']")
        .first();
      await parent.hover();
      await parent.getByRole("button", { name: "Expand", exact: true }).click();
    },
  },
  {
    name: "card",
    // The worktree DB's deployment with a run ledger (17 runs).
    path: "/deploy/server/srv-1784718612584-q17b8x/dep/dpl-1785501087837-xkt5u5",
    squeezes: true,
    open: async (page) => {
      // Its History card's table view ("All").
      const all = page.locator("[data-view-type='table']", { hasText: "All" });
      if ((await all.count()) === 0) {
        await page.getByText("History", { exact: true }).first().click();
      }
      await all.first().click();
    },
  },
  {
    name: "calls",
    path: "/debug/claude-cli-calls",
    // Its default view ("All") is a flat table; clicking the active chip
    // would open its settings instead.
    open: async () => {},
  },
];

/** The table's geometry relative to its sideways scroller. */
interface Probe {
  overflowing: boolean;
  scrollLeft: number;
  maxScroll: number;
  /** Left edges of every first-column cell (header + rows), from the scroller. */
  leads: number[];
  /** The second column's header left edge, from the scroller. */
  second: number | null;
  /** The first body cell's background alpha (1 = opaque). */
  leadAlpha: number | null;
  /** The toolbar band's left and right edges, from the scroller. */
  band: { left: number; right: number } | null;
  /** The scroller's visible width. */
  clientWidth: number;
  /** Left edges of the scroller's children that do not hold the table. */
  others: number[];
}

const probe = (page: Page): Promise<Probe> =>
  page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(
      "[data-slot='data-table-header']",
    )?.parentElement;
    if (!grid) throw new Error("no grid table on the page");
    let scroller: HTMLElement | null = grid.parentElement;
    while (scroller && getComputedStyle(scroller).overflowY === "visible") {
      scroller = scroller.parentElement;
    }
    if (!scroller) throw new Error("no scroller around the table");
    const origin = scroller.getBoundingClientRect().left;
    const rel = (el: Element) => el.getBoundingClientRect().left - origin;
    const header = grid.querySelector("[data-slot='data-table-header']")!;
    const leadOf = (row: Element) => row.firstElementChild;
    const rows = [...grid.querySelectorAll("[data-row-key]")].slice(0, 12);
    const leads = [header, ...rows]
      .map(leadOf)
      .filter((el): el is Element => el !== null)
      .map(rel);
    const firstBody = rows[0] ? leadOf(rows[0]) : null;
    const alpha = (el: Element | null) => {
      if (!el) return null;
      const bg = getComputedStyle(el).backgroundColor;
      const m = /rgba?\(([^)]+)\)/.exec(bg);
      if (!m) return bg.startsWith("color(") || bg.startsWith("oklch") ? 1 : 0;
      const parts = m[1]!.split(/[ ,/]+/).filter(Boolean);
      return parts.length >= 4 ? Number(parts[3]) : 1;
    };
    return {
      overflowing: !!grid.closest("[data-scrolls-x]"),
      scrollLeft: scroller.scrollLeft,
      maxScroll: scroller.scrollWidth - scroller.clientWidth,
      leads,
      second: header.children[1] ? rel(header.children[1]) : null,
      leadAlpha: alpha(firstBody),
      band: (() => {
        const el = document
          .querySelector("[data-view-type]")
          ?.closest(".z-nav");
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { left: b.left - origin, right: b.right - origin };
      })(),
      clientWidth: scroller.clientWidth,
      // Everything off the path from the scroller down to the table: the
      // children of each path box that do not hold the table.
      others: (() => {
        const out: Element[] = [];
        for (let p: Element | null = grid.parentElement; p && p !== scroller;) {
          const parent: Element | null = p.parentElement;
          if (!parent) break;
          for (const c of parent.children) if (c !== p) out.push(c);
          p = parent;
        }
        return out.filter((c) => c.getBoundingClientRect().width > 0).map(rel);
      })(),
    };
  });

const scrollRight = (page: Page, by: number) =>
  page.evaluate((dx) => {
    const grid = document.querySelector<HTMLElement>(
      "[data-slot='data-table-header']",
    )!.parentElement!;
    let scroller: HTMLElement | null = grid.parentElement;
    while (scroller && getComputedStyle(scroller).overflowY === "visible") {
      scroller = scroller.parentElement;
    }
    scroller!.scrollLeft = dx;
  }, by);

/** A squeezing table: no wide mode anywhere on the page, no pinned cell. */
async function checkSqueezed(
  r: Report,
  page: Page,
  label: string,
): Promise<void> {
  const state = await page.evaluate(() => {
    const header = document.querySelector("[data-slot='data-table-header']")!;
    const lead = header.firstElementChild!;
    const host = header.closest("[data-scroll-x-host]");
    return {
      wide: document.querySelector("[data-scrolls-x]") !== null,
      position: getComputedStyle(lead).position,
      paneScrollsX: host ? getComputedStyle(host).overflowX : "none",
    };
  });
  r.eq(`${label}: in a card, the table never goes wide`, state.wide, false);
  r.eq(`${label}: no pinned first column`, state.position, "static");
  // (Its columns may still overflow the card, as they did before P3: the
  // squeeze is today's layout, unchanged.)
  r.eq(
    `${label}: the pane never scrolls sideways for it`,
    state.paneScrollsX,
    "hidden",
  );
}

async function check(r: Report, page: Page, label: string): Promise<void> {
  const before = await probe(page);
  r.note(
    `${label}: overflowing=${before.overflowing} maxScroll=${before.maxScroll}`,
  );
  if (!before.overflowing) {
    r.ok(`${label}: fits — nothing scrolls sideways`, before.maxScroll <= 1);
    return;
  }
  r.ok(`${label}: overflows — the pane scrolls sideways`, before.maxScroll > 1);
  const by = Math.min(240, before.maxScroll);
  await scrollRight(page, by);
  await page.waitForTimeout(250);
  const after = await probe(page);
  await snap(page, OUT, `${label}-scrolled`);
  r.eq(`${label}: scrolled by ${by}`, Math.round(after.scrollLeft), by);
  r.ok(
    `${label}: every first-column cell pinned at the left edge`,
    after.leads.every((x) => Math.abs(x) < 1),
    JSON.stringify(after.leads),
  );
  r.ok(
    `${label}: a later column moved with the scroll`,
    before.second !== null &&
      after.second !== null &&
      Math.abs(before.second - by - after.second) < 1,
    `${before.second} → ${after.second}`,
  );
  r.eq(`${label}: the pinned cell is opaque`, after.leadAlpha, 1);
  r.ok(
    `${label}: the pane's other content stays put (${before.others.length})`,
    after.others.length === before.others.length &&
      after.others.every((x, i) => Math.abs(x - before.others[i]!) < 1),
    JSON.stringify({ before: before.others, after: after.others }),
  );
  r.ok(
    `${label}: the toolbar band stays in view`,
    after.band !== null &&
      Math.abs(after.band.left - (before.band?.left ?? NaN)) < 1 &&
      after.band.right <= after.clientWidth + 1,
    JSON.stringify({
      before: before.band,
      after: after.band,
      w: after.clientWidth,
    }),
  );
  await scrollRight(page, 0);
}

await withBrowser(async (h) => {
  const r = report("data-table — sticky first column + sideways scroll");
  for (const scheme of SCHEMES) {
    for (const surface of SURFACES) {
      for (const width of WIDTHS) {
        const label = `${surface.name}-${width}-${scheme}`;
        const { page, context, captured } = await h.session({
          colorScheme: scheme,
          viewport: { width, height: 800 },
        });
        await boot(page, pathUrl(surface.path), {
          marker: surface.squeezes
            ? "text=History"
            : "[data-view-type='table']",
          settleMs: 800,
        });
        await surface.open(page);
        await page
          .locator("[data-slot='data-table-header']")
          .first()
          .waitFor({ state: "visible" });
        await page.waitForTimeout(500);
        await snap(page, OUT, label);
        if (surface.squeezes) await checkSqueezed(r, page, label);
        else await check(r, page, label);
        const errors = [
          ...captured.pageErrors,
          ...captured.consoleErrors.filter(
            (e) => !/Failed to load resource/.test(e),
          ),
        ];
        r.ok(
          `${label}: no page or console errors`,
          errors.length === 0,
          errors.join("\n"),
        );
        await context.close();
      }
    }
  }
  await r.finish();
});
