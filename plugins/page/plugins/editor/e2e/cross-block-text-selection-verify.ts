// Cross-block text drag-select, verified in a real browser.
//
// Every text-bearing block mounts its OWN Lexical instance, i.e. its own
// contenteditable EDITING HOST — and a browser clamps a mouse selection to the host
// it started in. So a drag out of a block never extended the selection; it COLLAPSED
// it back to a bare caret. Measured on the unfixed build (Chromium, commit bdbae71e5):
//
//   intra-block control drag  -> {collapsed: false, text: " heading"}   (fine)
//   block 1 -> block 3 drag   -> {collapsed: true,  text: ""}           (nothing)
//   selection bar             -> 0 selected, 0 highlighted rows
//   clipboard after Cmd+C     -> "" (empty)
//
// The fix takes the gesture over at the boundary: the browser keeps the drag while
// it stays inside the origin block, and the moment the pointer leaves that row the
// editor turns it into an EDITOR-OWNED text span with partial ends, painted through
// the CSS Custom Highlight API (no native selection can cross editing hosts). Its
// first iteration promoted to a whole-BLOCK range instead; that is now one Escape
// away, and still copies as indented markdown through the block-selection path.
// The span's own semantics (Delete, undo, dragging back) are
// `cross-block-span-verify.ts`'s.
//
// Usage: bun plugins/page/plugins/editor/e2e/cross-block-text-selection-verify.ts [--url <deploy>]
import {
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { editableBlocks, openBlankPage } from "./support/blank-page";
import { highlightedLines } from "./support/block-selection";
import { typeLines } from "./support/type-lines";

const r = report();

await withBrowser(async (h) => {
  const { context, page } = await h.session();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await openBlankPage(page, { settleMs: 3000 });

  // A heading, a bullet, and a bullet indented under it — so the clipboard assertion
  // covers per-type markdown prefixes AND nesting, not just line breaks.
  await typeLines(page, [
    "# Alpha heading",
    "- Bravo bullet",
    // Enter on a bullet already mints a bullet, so this line must NOT re-type the
    // "- " shortcut — the type is inherited and the marker would stay literal text.
    { text: "Charlie nested", indent: "in" },
  ]);
  await page.waitForTimeout(2000);

  const block = (i: number) => editableBlocks(page).nth(i);
  r.eq("setup: three blocks", await editableBlocks(page).count(), 3);

  const readSelection = () =>
    page.evaluate(() => {
      const s = window.getSelection();
      const blockOf = (n: Node | null): string | null => {
        const el = n instanceof Element ? n : (n?.parentElement ?? null);
        return (
          el?.closest("[data-block-id]")?.getAttribute("data-block-id") ?? null
        );
      };
      return {
        collapsed: s?.isCollapsed ?? true,
        anchorBlock: blockOf(s?.anchorNode ?? null),
        focusBlock: blockOf(s?.focusNode ?? null),
        text: s?.toString() ?? "",
      };
    });

  const selectedCount = (): Promise<number | null> =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll("span")].find((s) =>
        /^\d+ selected$/.test(s.textContent ?? ""),
      );
      const n = el?.textContent?.split(" ")[0];
      return n === undefined ? null : Number(n);
    });

  const a = await block(0).boundingBox();
  const c = await block(2).boundingBox();
  if (!a || !c) throw new Error("no bounding boxes for the fixture blocks");

  // 1. CONTROL — the same gesture WITHIN one block must still be a plain text
  //    selection. This is the half of the feature the promotion must not eat.
  await page.mouse.move(a.x + a.width * 0.1, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width * 0.5, a.y + a.height / 2, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const control = await readSelection();
  r.eq("intra-block drag still selects text", control.text.length > 0, true);
  r.eq(
    "intra-block drag stays in ONE block",
    control.anchorBlock,
    control.focusBlock,
  );
  r.eq(
    "intra-block drag does NOT enter block-selection",
    (await selectedCount()) ?? 0,
    0,
  );

  // The text the editor's span paints, one string per Range ([] when none). An
  // end landing past a short line's last character paints nothing on that line
  // (an empty range is not drawn), so the assertions read the MIDDLE line, which
  // any span from block 1 to block 3 covers whole.
  const painted = (): Promise<string[]> =>
    page.evaluate(() => {
      const h = CSS.highlights.get("page-text-span");
      return h ? [...h].map((range) => range.toString()) : [];
    });

  // 2. Crossing a block boundary makes an editor-owned text span over all three.
  await page.mouse.move(a.x + a.width * 0.4, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width * 0.6, a.y + a.height / 2, { steps: 5 });
  await page.mouse.move(c.x + c.width * 0.5, c.y + c.height / 2, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  r.eq(
    "crossing blocks paints a span covering the middle line whole",
    (await painted()).includes("Bravo bullet"),
    true,
  );
  r.eq("…and selects no block whole", (await selectedCount()) ?? 0, 0);
  r.eq("…so no row band is drawn", await highlightedLines(page), 0);
  const promoted = await readSelection();
  r.eq("no text caret is left parked in a block", promoted.text, "");

  // A span copies as a PARTIAL forest: exactly the painted text, each line
  // keeping its block's prefix and nesting — never the touched blocks whole.
  // The heading line holds only what the span painted on it (the drag starts
  // wherever 40% of the row lands, possibly past the text's end), and the end
  // line only up to the span's end.
  const spanText = await painted();
  const headingPart = spanText.length === 3 ? spanText[0]! : "";
  const endPart = spanText.at(-1)!;
  await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
  await page.keyboard.press("ControlOrMeta+c");
  await page.waitForTimeout(300);
  const spanClip = (
    await page.evaluate(() => navigator.clipboard.readText())
  ).split("\n");
  console.log("span clipboard:\n---\n" + spanClip.join("\n") + "\n---");
  r.eq(
    "Cmd+C over a span writes its partial markdown, line by line",
    spanClip.map((line) => line.trimEnd()),
    [
      `# ${headingPart}`.trimEnd(),
      "* Bravo bullet",
      `  * ${endPart}`.trimEnd(),
    ],
  );

  // 3. Escape climbs to the touched blocks, whole — which copies as markdown,
  //    prefixes and nesting intact, through the block-selection clipboard path.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  r.eq("Escape turns the span into all three blocks", await selectedCount(), 3);
  r.eq("all three rows are highlighted", await highlightedLines(page), 3);
  await page.keyboard.press("ControlOrMeta+c");
  await page.waitForTimeout(500);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  console.log("clipboard text/plain:\n---\n" + clip + "\n---");
  r.eq("clipboard is non-empty", clip.trim().length > 0, true);
  r.eq(
    "clipboard kept the heading prefix",
    /(^|\n)#\s+Alpha heading/.test(clip),
    true,
  );
  // `bulleted-list.markdownPrefixes` is ["* ", "- ", "+ "]; the serializer emits the
  // FIRST entry and the rest are parse-only aliases, so the round-trip is "* ".
  r.eq(
    "clipboard kept the bullet prefix",
    /(^|\n)\*\s+Bravo bullet/.test(clip),
    true,
  );
  r.eq(
    "clipboard kept the nesting indent",
    /\n\s{2,}\*\s+Charlie nested/.test(clip),
    true,
  );

  // 4. An upward drag makes the same span (`normalizeSpan` orders either way).
  await page.keyboard.press("Escape"); // drop the block selection first
  await page.waitForTimeout(400);
  await page.mouse.move(c.x + c.width * 0.5, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width * 0.4, a.y + a.height / 2, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  r.eq(
    "an upward cross-block drag paints the same span",
    (await painted()).includes("Bravo bullet"),
    true,
  );
  r.eq("…and selects no block whole", (await selectedCount()) ?? 0, 0);

  await r.finish();
});
