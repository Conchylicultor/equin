// Drag-to-select must belong to the pane it happens in.
//
// The Pages app can show two documents side by side (`/pages/page/:a/page/:b`),
// which mounts TWO `BlockEditor`s. Every pointer gesture in either one has to
// resolve to a row of ITS OWN editor.
//
// Measured baseline, against `main` at 1440x900 with two 8-row pages open:
//
//   right pane, background drag rows 1 -> 5   0 rows selected in the right pane
//                                             (the marquee painted, the range
//                                             named left-pane ids)
//   right pane, text drag across two rows     0 rows selected, and the native
//                                             selection collapsed
//
// Cause: `rowAtPointer` scanned `document` for `[data-block-id]`, so the FIRST
// pane holding a row at the pointer's y won the contains-test — always the left
// one, which comes first in DOM order.
//
// Usage:
//   ./equin run plugins/page/plugins/editor/e2e/two-pane-selection-verify.ts \
//     [--url <deploy>] [--headed]
import {
  pathUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage } from "./support/blank-page";

const r = report();

/** Lines seeded into each page — enough to drag across several rows. */
const TYPED_LINES = 7;

await withBrowser(async (h) => {
  const { page } = await h.session();

  /** Seed a fresh page with `TYPED_LINES` numbered lines; returns its page id. */
  const seedPage = async (tag: string): Promise<string> => {
    const doc = await openBlankPage(page, { settleMs: 2000 });
    for (let i = 0; i < TYPED_LINES; i++) {
      await page.keyboard.type(`${tag} line ${i}`);
      await page.waitForTimeout(120);
      if (i < TYPED_LINES - 1) {
        await page.keyboard.press("Enter");
        await page.waitForTimeout(120);
      }
    }
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    return doc.pageId;
  };

  const left = await seedPage("left");
  const right = await seedPage("right");

  await page.goto(pathUrl(`/pages/page/${left}/page/${right}`), {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const surfaces = page.locator('[aria-label="Page blocks"]');
  await surfaces.nth(1).waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(3000);

  const paneCount = await surfaces.count();
  r.ok(`two block lists are open side by side (${paneCount})`, paneCount === 2);

  /** Rows of one pane, by its index among the open block lists. */
  const rowsOf = (pane: number) =>
    page.evaluate((p) => {
      const surface = document.querySelectorAll('[aria-label="Page blocks"]')[
        p
      ];
      if (!surface) return [];
      return [...surface.querySelectorAll("[data-block-id]")].map((el) => {
        const b = el.getBoundingClientRect();
        return {
          id: el.getAttribute("data-block-id") ?? "",
          left: b.left,
          right: b.right,
          centerY: b.top + b.height / 2,
        };
      });
    }, pane);

  /** How many rows each pane currently shows as selected. */
  const selectedPerPane = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[aria-label="Page blocks"]')].map(
        (surface) =>
          [...surface.querySelectorAll("[data-block-id]")].filter((row) =>
            (row.textContent ?? "").includes("Selected."),
          ).length,
      ),
    );

  const nativeSelectionText = () =>
    page.evaluate(() => window.getSelection()?.toString() ?? "");

  /**
   * Classify a point the way `onPointerDown` does — and say WHICH pane's editor
   * would claim it. A background press is the marquee's entry point; a press on
   * a rail control, or inside a block's text, is a different gesture entirely,
   * so a case that lands on one would be asserting the wrong thing.
   */
  const backgroundPaneAt = (x: number, y: number) =>
    page.evaluate(
      ({ px, py }) => {
        const surfaces = [
          ...document.querySelectorAll('[aria-label="Page blocks"]'),
        ];
        const el = document.elementFromPoint(px, py);
        if (!el) return -1;
        const pane = surfaces.findIndex((s) => s.contains(el));
        if (pane < 0) return -1;
        if (el.closest("button")) return -1;
        if (el.closest('[contenteditable="true"]')) return -1;
        const background =
          el === surfaces[pane] ||
          el.hasAttribute("data-block-id") ||
          el.hasAttribute("data-caret-host") ||
          el.hasAttribute("data-block-chrome") ||
          el.closest("[data-block-id]") === null;
        return background ? pane : -1;
      },
      { px: x, py: y },
    );

  const leftRows = await rowsOf(0);
  const rightRows = await rowsOf(1);
  r.ok(
    `each pane rendered its own rows (left ${leftRows.length}, right ${rightRows.length})`,
    leftRows.length >= 6 && rightRows.length >= 6,
  );
  r.ok(
    "the two panes are horizontally disjoint (a right-pane x is never over a left-pane row)",
    (rightRows[0]?.left ?? 0) >= (leftRows[0]?.right ?? Infinity),
  );

  // The fixture must actually EXERCISE the hazard, or every assertion below
  // passes for the wrong reason. So state the old resolution directly: scan the
  // document in DOM order, the way `rowAtPointer` used to, and check that a
  // right-pane y resolves to a LEFT-pane row. If a future layout ever stops the
  // panes from overlapping vertically, this fails loudly instead of leaving the
  // script green and blind.
  const documentOrderPaneAt = (y: number) =>
    page.evaluate((py) => {
      const surfaces = [
        ...document.querySelectorAll('[aria-label="Page blocks"]'),
      ];
      for (const el of document.querySelectorAll("[data-block-id]")) {
        const b = el.getBoundingClientRect();
        if (b.height > 0 && py >= b.top && py <= b.bottom)
          return surfaces.findIndex((s) => s.contains(el));
      }
      return -1;
    }, y);

  const hazardPane = await documentOrderPaneAt(rightRows[3]!.centerY);
  r.ok(
    `a document-wide row scan resolves a right-pane y to the LEFT pane (pane ${hazardPane}) — the bug this script guards`,
    hazardPane === 0,
  );

  const clear = async () => {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  };

  /** Press, drag in steps, read the per-pane selection, release. */
  const drag = async (x: number, from: number, to: number) => {
    await page.mouse.move(x, from);
    await page.waitForTimeout(120);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(x, from + ((to - from) * i) / 6);
      await page.waitForTimeout(40);
    }
    const counts = await selectedPerPane();
    const native = await nativeSelectionText();
    await page.mouse.up();
    await page.waitForTimeout(250);
    return { counts, native };
  };

  // ---- Background (marquee) drag in each pane -------------------------------

  for (const [name, pane, rows] of [
    ["left", 0, leftRows],
    ["right", 1, rightRows],
  ] as const) {
    await clear();
    const first = rows[1]!;
    const last = rows[5]!;
    // The candidates the editor calls background, in the order the gutter-drag
    // script names them. Which one is reachable depends on the column's width,
    // so probe rather than assume — and park the pointer first, since the rail's
    // controls are hover-revealed and only then hit-testable.
    let x = -1;
    for (const cx of [first.left + 8, first.left + 2, first.right - 12]) {
      await page.mouse.move(cx, first.centerY);
      await page.waitForTimeout(120);
      if ((await backgroundPaneAt(cx, first.centerY)) === pane) {
        x = cx;
        break;
      }
    }
    r.ok(
      `${name} pane: found an editor-background press point (x=${x})`,
      x > 0,
    );
    if (x < 0) continue;
    const { counts } = await drag(x, first.centerY, last.centerY);
    const other = pane === 0 ? 1 : 0;
    r.ok(
      `${name} pane: a background drag selects rows in THIS pane (${counts[pane]} selected)`,
      (counts[pane] ?? 0) >= 4,
    );
    r.ok(
      `${name} pane: the other pane stays untouched (${counts[other]} selected)`,
      (counts[other] ?? 0) === 0,
    );
  }

  // ---- Text drag crossing a block boundary, in each pane --------------------

  for (const [name, pane, rows] of [
    ["left", 0, leftRows],
    ["right", 1, rightRows],
  ] as const) {
    await clear();
    const first = rows[1]!;
    const last = rows[3]!;
    // Inside the text measure, so the press starts as a native text selection
    // and the editor promotes it at the first block boundary.
    const x = first.left + (first.right - first.left) / 2;
    const { counts, native } = await drag(x, first.centerY, last.centerY);
    const other = pane === 0 ? 1 : 0;
    r.ok(
      `${name} pane: a text drag across rows promotes to a block range here (${counts[pane]} selected)`,
      (counts[pane] ?? 0) >= 3,
    );
    r.ok(
      `${name} pane: the other pane stays untouched (${counts[other]} selected)`,
      (counts[other] ?? 0) === 0,
    );
    r.ok(
      `${name} pane: the promoted drag leaves no native text selection (${JSON.stringify(native.slice(0, 40))})`,
      native === "",
    );
  }
});

await r.finish();
