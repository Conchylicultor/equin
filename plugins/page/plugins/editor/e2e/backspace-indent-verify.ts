// Backspace-at-start: only EXCESS indentation comes off before the line break.
//
// The keystroke ladder strips indentation ahead of the line break above ONLY
// while the block sits deeper than the visible line below it. Indentation it
// shares with the content that follows is not standing between the caret and
// that break, so Backspace merges instead (Notion's model). The regression this
// pins: every indented block peeled its levels one press at a time, so a block
// already level with the line below it took an extra press — and, worse, its
// outdent adopted the followers below it as its own children.
//
// Three scenarios, each on a fresh blank page (rendered left padding is the
// observable indent depth):
//
//   1. shared      aaa /   bbb| /   ccc     → ONE press merges; ccc unmoved
//   2. excess      aaa /   aaa2 /     bbb| /   ccc
//                  → press 1 outdents bbb level with ccc (nothing else moves)
//                  → press 2 merges it into aaa2
//   3. no next     aaa /   bbb|        → press 1 outdents (unchanged ladder)
//                                       → press 2 merges
//
// Usage: bun plugins/page/plugins/editor/e2e/backspace-indent-verify.ts \
//          [--url <deploy>] [--out /tmp/bsi]
import type { Page } from "playwright";
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage } from "./support/blank-page";
import { caretLinear } from "./support/caret";
import { typeLines } from "./support/type-lines";

const out = arg("out", "/tmp/bsi");
const r = report();

interface Row {
  id: string;
  text: string;
  /** Rendered left padding — the indent depth, in px. */
  pad: number;
}

/** Every block row in document order, with its text and rendered indent. */
async function rows(page: Page): Promise<Row[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("[data-block-id]")).map((el) => ({
      id: el.getAttribute("data-block-id") ?? "",
      text: (el.textContent ?? "").replace(/ /g, " ").trim(),
      pad: parseFloat(getComputedStyle(el).paddingLeft),
    })),
  );
}

/** `text@pad` per row — the whole document shape in one comparable string. */
function shape(rs: Row[]): string {
  return rs.map((row) => `${row.text}@${row.pad}`).join(" | ");
}

/**
 * Park the caret at the very start of `id`'s text. Clicking the left edge lands
 * at offset 0 in practice; the ArrowLeft loop is the exact-count fallback (never
 * over-pressing, which would cross into the previous block).
 */
async function caretToStartOf(page: Page, id: string): Promise<void> {
  const block = page
    .locator(`[data-block-id="${id}"] [data-block-text]`)
    .first();
  await block.click({ position: { x: 2, y: 8 } });
  await page.waitForTimeout(200);
  for (let guard = 0; guard < 40; guard++) {
    const at = await caretLinear(page);
    if (at <= 0) return;
    await page.keyboard.press("ArrowLeft");
  }
}

/**
 * How long to let a fixture's Tab / Shift+Tab settle before measuring. NOT a
 * typing settle: each is a structural indent/outdent op, and `pad` is read off
 * the rendered row, so the op's rows must be back first.
 */
const INDENT_OP_MS = 1500;

/**
 * How long to let a Backspace's resolved op (convertTo / outdent / merge) land
 * before reading the document shape. Same reason as `INDENT_OP_MS` — this is the
 * keystroke under test, so the wait is after it, never before.
 */
const KEYSTROKE_OP_MS = 1500;

await withBrowser(async (h) => {
  const { page } = await h.session();

  // --- 1. shared indentation: ONE press merges, the follower stays put -------
  {
    await openBlankPage(page, { settleMs: 2500 });
    await typeLines(page, ["aaa", { text: "bbb", indent: "in" }, "ccc"]);
    await page.waitForTimeout(INDENT_OP_MS);

    const before = await rows(page);
    console.log("1 setup:", shape(before));
    r.ok(
      "1 setup: aaa / indented bbb / indented ccc",
      before.length === 3 &&
        before[0]!.text === "aaa" &&
        before[1]!.text === "bbb" &&
        before[2]!.text === "ccc" &&
        before[1]!.pad > before[0]!.pad &&
        before[1]!.pad === before[2]!.pad,
      shape(before),
    );
    const cccPad = before[2]!.pad;

    await caretToStartOf(page, before[1]!.id);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(KEYSTROKE_OP_MS);
    await snap(page, out, "1-shared-merged");

    const after = await rows(page);
    console.log("1 after:", shape(after));
    r.ok(
      "1: a block level with the line below it merges in ONE press",
      after.length === 2 && after[0]!.text === "aaabbb",
      shape(after),
    );
    r.ok(
      "1: the follower keeps its own indentation (never adopted)",
      after.length === 2 &&
        after[1]!.text === "ccc" &&
        after[1]!.pad === cccPad,
      `${cccPad} → ${after[1]?.pad}`,
    );
    r.ok("1: the caret sits at the join", (await caretLinear(page)) === 3);
  }

  // --- 2. excess indentation: outdent to the next line's level, then merge ---
  {
    await openBlankPage(page, { settleMs: 2500 });
    await typeLines(page, [
      "aaa",
      { text: "aaa2", indent: "in" },
      { text: "bbb", indent: "in" },
      { text: "ccc", indent: "out" },
    ]);
    await page.waitForTimeout(INDENT_OP_MS);

    const before = await rows(page);
    console.log("2 setup:", shape(before));
    const [a, a2, b, c] = before;
    r.ok(
      "2 setup: aaa / aaa2 / bbb two deep / ccc one deep",
      before.length === 4 &&
        a!.text === "aaa" &&
        a2!.text === "aaa2" &&
        b!.text === "bbb" &&
        c!.text === "ccc" &&
        a!.pad < a2!.pad &&
        a2!.pad < b!.pad &&
        a2!.pad === c!.pad,
      shape(before),
    );

    await caretToStartOf(page, b!.id);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(KEYSTROKE_OP_MS);
    await snap(page, out, "2-excess-outdented");

    const mid = await rows(page);
    console.log("2 press 1:", shape(mid));
    r.ok(
      "2 press 1: strips ONLY the excess level — bbb lands level with ccc",
      mid.length === 4 &&
        mid.map((row) => row.text).join(",") === "aaa,aaa2,bbb,ccc" &&
        mid[2]!.pad === c!.pad,
      shape(mid),
    );
    r.ok(
      "2 press 1: nothing else moves (the outdent adopted no follower)",
      mid.length === 4 &&
        mid[0]!.pad === a!.pad &&
        mid[1]!.pad === a2!.pad &&
        mid[3]!.pad === c!.pad,
      shape(mid),
    );

    await page.keyboard.press("Backspace");
    await page.waitForTimeout(KEYSTROKE_OP_MS);
    await snap(page, out, "3-excess-merged");

    const after = await rows(page);
    console.log("2 press 2:", shape(after));
    r.ok(
      "2 press 2: no excess left → merges into the line above",
      after.length === 3 &&
        after.map((row) => row.text).join(",") === "aaa,aaa2bbb,ccc" &&
        after[2]!.pad === c!.pad,
      shape(after),
    );
  }

  // --- 3. no next visible line: the original peel-then-merge ladder ----------
  {
    await openBlankPage(page, { settleMs: 2500 });
    await typeLines(page, ["aaa", { text: "bbb", indent: "in" }]);
    await page.waitForTimeout(INDENT_OP_MS);

    const before = await rows(page);
    console.log("3 setup:", shape(before));
    r.ok(
      "3 setup: aaa / indented bbb, nothing below",
      before.length === 2 &&
        before[1]!.text === "bbb" &&
        before[1]!.pad > before[0]!.pad,
      shape(before),
    );

    await caretToStartOf(page, before[1]!.id);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(KEYSTROKE_OP_MS);
    await snap(page, out, "4-last-line-outdented");

    const mid = await rows(page);
    console.log("3 press 1:", shape(mid));
    r.ok(
      "3 press 1: the last visible line is excess-indented → outdent",
      mid.length === 2 && mid[1]!.text === "bbb" && mid[1]!.pad === mid[0]!.pad,
      shape(mid),
    );

    await page.keyboard.press("Backspace");
    await page.waitForTimeout(KEYSTROKE_OP_MS);
    const after = await rows(page);
    console.log("3 press 2:", shape(after));
    r.ok(
      "3 press 2: then merges",
      after.length === 1 && after[0]!.text === "aaabbb",
      shape(after),
    );
  }

  await r.finish();
});
