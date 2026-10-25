// A drag that STARTS on the editor background must never leave a native text
// selection behind.
//
// A background press (a row's gutter rail, the strip between the decoration edge
// and the text, a list marker's column, the whitespace beside the centered
// measure) is the editor's OWN gesture: it paints the marquee and selects whole
// blocks. The browser's mousedown default action used to run alongside it and
// start a native text selection from whatever text position it hit-tested the
// press to — a position that is NOT clamped to any editing host, because its
// anchor is in none, so dragging swept the document from that anchor to the
// pointer and the page highlighted from far above the gesture.
//
// Measured baseline, against `main` at 1280x800 on a real 173-row page
// (`--page`), before `block-selection-scope.css` existed:
//
//   gutter rail, rows 3 -> 5    native selection NON-EMPTY, anchored at row 3:
//                               "\nequin test\n\nSelected.\nequin
//                               check\n\nSelected." — the rows' sr-only
//                               selection markers, which is what a cross-host
//                               selection copies instead of their text
//   marker column / line inset  the press reached no gesture at all (the editor
//                               returned early on a row descendant), so the
//                               browser owned it outright — a scan of x across
//                               the left area showed the anchor landing on the
//                               row under the pointer with the drag free to run
//                               anywhere in the document
//
// Not every x leaked on every run — the hit-test answer depends on which box's
// padding the press lands in, which is exactly why the report says "sometimes".
//
// Usage:
//   ./equin run plugins/page/plugins/editor/e2e/gutter-drag-selection-verify.ts \
//     [--url <deploy>] [--page <page url>] [--headed]
//
// `--page` drives an EXISTING document instead of creating a blank one (it seeds
// nothing and types nothing — the gesture is read-only), which is how this was
// reproduced against the reported page.
import {
  arg,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { editableBlocks, openBlankPage } from "./support/blank-page";

const existingPage = arg("page");
const r = report();

/** Lines seeded into a fresh blank page, enough to drag across several rows. */
const TYPED_LINES = 14;

await withBrowser(async (h) => {
  const { page } = await h.session();

  /** The live viewport rect of the Nth `[data-block-id]` row. */
  const rowRect = (index: number) =>
    page.evaluate((i) => {
      const el = document.querySelectorAll("[data-block-id]")[i];
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        top: b.top,
        bottom: b.bottom,
        left: b.left,
        right: b.right,
        centerY: b.top + b.height / 2,
      };
    }, index);

  const surfaceRect = () =>
    page.evaluate(() => {
      const el = document.querySelector('[aria-label="Page blocks"]');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    });

  /**
   * What the browser's own selection holds, plus WHICH row it is anchored in —
   * the anchor index is what says "the whole page from the top", as opposed to
   * a stray one-word selection on the row under the pointer.
   */
  const nativeSelection = () =>
    page.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return { text: "", anchorRow: -1 };
      const rows = [...document.querySelectorAll("[data-block-id]")];
      const anchorRow = rows.findIndex((el) => el.contains(sel.anchorNode));
      return { text: sel.toString(), anchorRow };
    });

  /** The editor's own block selection, off the selection bar's "N selected". */
  const selectedCount = (): Promise<number> =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll("span")].find((s) =>
        /^\d+ selected$/.test(s.textContent ?? ""),
      );
      const n = el?.textContent?.split(" ")[0];
      return n === undefined ? 0 : Number(n);
    });

  /**
   * Classify a point the way `onPointerDown` does, so a miss is never silent.
   *
   * Read AFTER the pointer is already parked there: the gutter rail's controls
   * are hover-revealed (hidden ones are `pointer-events-none`, so they are not
   * even hit-testable), and whether a press in the rail reaches a control or the
   * row beneath it is exactly that difference.
   */
  const isBackgroundPoint = (x: number, y: number) =>
    page.evaluate(
      ({ px, py }) => {
        const surface = document.querySelector('[aria-label="Page blocks"]');
        const el = document.elementFromPoint(px, py);
        if (!surface || !el || !surface.contains(el)) return false;
        if (el.closest("button")) return false;
        if (el.closest('[contenteditable="true"]')) return false;
        // Mirrors `onPointerDown`'s own classification: the surface itself, a
        // row element itself (its gutter rail is its own padding), a void
        // block's caret host, a row's pure-geometry chrome, or something that
        // is not inside a row at all.
        return (
          el === surface ||
          el.hasAttribute("data-block-id") ||
          el.hasAttribute("data-caret-host") ||
          el.hasAttribute("data-block-chrome") ||
          el.closest("[data-block-id]") === null
        );
      },
      { px: x, py: y },
    );

  // ---- Fixture --------------------------------------------------------------

  if (existingPage) {
    await page.goto(existingPage, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await editableBlocks(page)
      .first()
      .waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForTimeout(3000);
  } else {
    await openBlankPage(page, { settleMs: 3000 });
    for (let i = 0; i < TYPED_LINES; i++) {
      await page.keyboard.type(`line ${String(i).padStart(2, "0")}`);
      await page.waitForTimeout(150);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(150);
    }
    // Leave text-edit mode without selecting anything, so each case starts clean.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }

  const total = await page.evaluate(
    () => document.querySelectorAll("[data-block-id]").length,
  );
  r.ok(`the document has enough rows to drag across (${total})`, total >= 6);

  const surface = await surfaceRect();
  if (!surface) throw new Error("no block-list surface on the page");

  // Rows well inside the document, so each gesture is a plain mid-page drag with
  // content both above and below it that must NOT be swept in.
  const UPPER = 4;
  const LOWER = 10;
  const upper = await rowRect(UPPER);
  const lower = await rowRect(LOWER);
  if (!upper || !lower)
    throw new Error(`the document is shorter than ${LOWER + 1} rows`);

  /**
   * Every x on a row's line that the editor calls background, named. Computed
   * per row rather than once, because a row's own boxes are where three of the
   * four live and rows differ in depth and type.
   *
   * `line inset` is the strip the report is about: between the row's decoration
   * edge and its text, inside the block's own skeleton rather than in the row's
   * gutter padding.
   */
  const pressPointsFor = (index: number) =>
    page.evaluate((i) => {
      const surface = document.querySelector('[aria-label="Page blocks"]');
      const row = document.querySelectorAll("[data-block-id]")[i];
      if (!surface || !row) return [];
      const s = surface.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      const points = [
        { name: "far-left whitespace", x: s.left + 12 },
        { name: "gutter rail", x: r.left + 8 },
        { name: "right margin", x: s.right - 12 },
      ];
      // The innermost chrome box on this row is its LINE; its left edge is the
      // block's decoration edge, and the first few px of it are the inset strip.
      const chrome = [...row.querySelectorAll("[data-block-chrome]")].at(-1);
      if (chrome) {
        points.splice(2, 0, {
          name: "line inset",
          x: chrome.getBoundingClientRect().left + 3,
        });
      }
      return points;
    }, index);

  const directions = [
    { name: "downward", row: UPPER, from: upper.centerY, to: lower.centerY },
    { name: "upward", row: LOWER, from: lower.centerY, to: upper.centerY },
  ];

  for (const d of directions) {
    for (const c of await pressPointsFor(d.row)) {
      const label = `${c.name}, ${d.name}`;
      // Clear whatever the previous case left, without a click on the background
      // (a plain background click routes the caret and can append a paragraph).
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);

      // Park the pointer FIRST, so the row's hover rail is revealed and the
      // classification below sees what the press will actually land on.
      await page.mouse.move(c.x, d.from);
      await page.waitForTimeout(120);
      // A press on a rail CONTROL is that control's own — it starts no marquee,
      // and asserting one would be asserting the wrong thing. It must still
      // leave no native selection, which is what the two checks below cover, so
      // the case is never skipped, only narrowed.
      const background = await isBackgroundPoint(c.x, d.from);
      r.note(
        `${label}: the press lands on ${background ? "editor background" : "a gutter control"}`,
      );

      await page.mouse.down();
      // Several steps, so the gesture is unmistakably a drag and the pointer
      // handler runs its per-frame body more than once.
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(c.x, d.from + ((d.to - d.from) * i) / 6);
        await page.waitForTimeout(30);
      }

      const during = await nativeSelection();
      const selected = await selectedCount();
      await page.mouse.up();
      await page.waitForTimeout(200);
      const after = await nativeSelection();

      r.ok(
        `${label}: no native text selection during the drag (got ${JSON.stringify(
          during.text.slice(0, 60),
        )} anchored at row ${during.anchorRow})`,
        during.text === "",
      );
      r.ok(
        `${label}: no native text selection after the drag (got ${JSON.stringify(
          after.text.slice(0, 60),
        )})`,
        after.text === "",
      );
      if (background) {
        r.ok(
          `${label}: the editor selected the swept blocks instead (${selected} selected)`,
          selected >= 2,
        );
      } else {
        r.ok(
          `${label}: a press on a gutter control starts no block selection (${selected} selected)`,
          selected === 0,
        );
      }
    }
  }
});

await r.finish();
