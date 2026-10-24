/**
 * Drags a real mouse selection across an active-data chip in a transcript and
 * checks the chip is selected as ONE unit: no per-character highlight on its
 * label, and a ring on the whole chip while the selection covers it.
 *
 *   ./equin run plugins/primitives/plugins/dom/plugins/copy-source-text/e2e/selection-verify.ts \
 *     --conv <id> [--out /tmp/chip-select]
 *
 * FIXTURE: a conversation whose transcript shows an active-data chip (`att-…`
 * / `conv-…` / a backticked plugin name) in prose, with words on both sides of
 * it. The view opens at the bottom, so the chip must be in the last screenful.
 */
import {
  arg,
  pathUrl,
  report,
  requireArg,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

interface Point {
  x: number;
  y: number;
}

interface Target {
  declared: string;
  before: Point;
  after: Point;
  middle: Point;
  clip: { x: number; y: number; width: number; height: number };
}

interface State {
  ringed: boolean;
  boxShadow: string;
  userSelect: string;
  selectedText: string;
}

const r = report("copy-source-text:selection");
const conv = requireArg(
  "conv",
  "selection-verify.ts --conv <conversation-id whose transcript shows an active-data chip>",
);
const out = arg("out") ?? "/tmp/chip-select";

await withBrowser(async (harness) => {
  const { page } = await harness.session();
  await page.goto(pathUrl(`/agents/c/${conv}`), {
    waitUntil: "domcontentloaded",
  });

  const found = await waitFor(
    () =>
      page.evaluate((): Target | null => {
        const chips = [
          ...document.querySelectorAll(
            '[data-copy-text]:not([data-copy-text=""])',
          ),
        ];
        // The nearest words before / after the chip inside the same paragraph
        // or list item — never inside the chip itself.
        const textAround = (chip: Element, forward: boolean): Text | null => {
          const block = chip.closest("p, li");
          if (!block) return null;
          const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
          const texts: Text[] = [];
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (chip.contains(n)) continue;
            if ((n.textContent ?? "").trim().length === 0) continue;
            const pos = chip.compareDocumentPosition(n);
            const after = (pos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
            if (after === forward) texts.push(n as Text);
          }
          return (forward ? texts[0] : texts.at(-1)) ?? null;
        };
        for (const chip of chips) {
          const box = chip.firstElementChild?.getBoundingClientRect();
          if (!box || box.width === 0) continue;
          if (box.top < 0 || box.bottom > window.innerHeight) continue;
          const prev = textAround(chip, false);
          const next = textAround(chip, true);
          if (!prev || !next) continue;
          const charRect = (text: Text, at: number) => {
            const range = document.createRange();
            range.setStart(text, at);
            range.setEnd(text, at + 1);
            return range.getBoundingClientRect();
          };
          const startRect = charRect(prev, Math.max(0, prev.length - 3));
          const endRect = charRect(next, Math.min(next.length - 1, 2));
          const y = box.top + box.height / 2;
          // Inside the viewport is not on screen: a chip scrolled up under the
          // pane header is still in the viewport, and a drag there hits chrome.
          const hits = (x: number, py: number, owner: Node) => {
            const at = document.elementFromPoint(x, py);
            return at !== null && owner.contains(at);
          };
          const block = chip.closest("p, li")!;
          if (
            !hits(box.left + box.width / 2, y, chip) ||
            !hits(
              startRect.left + 1,
              startRect.top + startRect.height / 2,
              block,
            ) ||
            !hits(endRect.right - 1, endRect.top + endRect.height / 2, block)
          )
            continue;
          return {
            declared: chip.getAttribute("data-copy-text") ?? "",
            before: {
              x: startRect.left + 1,
              y: startRect.top + startRect.height / 2,
            },
            after: {
              x: endRect.right - 1,
              y: endRect.top + endRect.height / 2,
            },
            middle: { x: box.left + box.width / 2, y },
            clip: (() => {
              const b = chip.closest("p, li")!.getBoundingClientRect();
              return {
                x: Math.max(0, b.left - 16),
                y: Math.max(0, b.top - 16),
                width: b.width + 32,
                height: b.height + 32,
              };
            })(),
          };
        }
        return null;
      }),
    (v) => v !== null,
  );

  const target = found.value;
  if (!target) {
    const why = await page.evaluate(() => {
      const chips = [
        ...document.querySelectorAll(
          '[data-copy-text]:not([data-copy-text=""])',
        ),
      ];
      const visible = chips.filter((c) => {
        const b = c.firstElementChild?.getBoundingClientRect();
        return b && b.width > 0 && b.top >= 0 && b.bottom <= window.innerHeight;
      });
      const sample = visible[0]?.parentElement?.outerHTML.slice(0, 600) ?? "";
      return `${chips.length} substituting, ${visible.length} on screen; first's parent: ${sample}`;
    });
    r.fail(
      "an in-prose chip with words on both sides is on screen",
      `waited ${found.waitedMs}ms — ${why}`,
    );
    await r.finish();
    return;
  }
  r.note(`chip declares ${JSON.stringify(target.declared)}`);

  const read = () =>
    page.evaluate((declared: string): State => {
      const chip = [...document.querySelectorAll("[data-copy-text]")].find(
        (c) => c.getAttribute("data-copy-text") === declared,
      )!;
      const box = getComputedStyle(chip.firstElementChild!);
      return {
        ringed: chip.hasAttribute("data-copy-text-selected"),
        boxShadow: box.boxShadow,
        userSelect: box.userSelect || box.webkitUserSelect,
        selectedText: window.getSelection()?.toString() ?? "",
      };
    }, target.declared);

  const clearSelection = () =>
    page.evaluate(() => window.getSelection()?.removeAllRanges());

  const drag = async (from: Point, to: Point) => {
    await clearSelection();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(100);
  };

  // 1. Across the whole chip.
  await drag(target.before, target.after);
  const across = await read();
  await page.screenshot({ path: `${out}-across.png`, clip: target.clip });
  r.note(`selected text    ${JSON.stringify(across.selectedText)}`);
  r.ok("the chip is ringed while the selection spans it", across.ringed);
  r.ok(
    "the ring is painted on the chip's box",
    across.boxShadow !== "none",
    across.boxShadow,
  );
  r.eq("the chip's letters take no highlight", across.userSelect, "none");

  // Unselectable letters must not fall out of the copy: the handler clones the
  // range, which still holds the chip, and puts its token back.
  const copied = await page.evaluate(() => {
    const transfer = new DataTransfer();
    document.dispatchEvent(
      new ClipboardEvent("copy", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
    return transfer.getData("text/plain");
  });
  r.note(`copied text      ${JSON.stringify(copied)}`);
  r.ok(
    "the copy still carries the chip's token",
    copied.includes(target.declared),
    `no ${JSON.stringify(target.declared)} in ${JSON.stringify(copied)}`,
  );

  // 2. Ending halfway into the chip: the old half-highlighted label.
  await drag(target.before, target.middle);
  const half = await read();
  await page.screenshot({ path: `${out}-half.png`, clip: target.clip });
  r.note(
    `drag ending mid-chip → ringed=${half.ringed}, selected ${JSON.stringify(half.selectedText)}`,
  );

  // 3. Dropping the selection clears it.
  await clearSelection();
  await page.waitForTimeout(100);
  const cleared = await read();
  r.ok("the ring clears when the selection goes away", !cleared.ringed);

  r.note(`screenshots: ${out}-across.png, ${out}-half.png`);
});

await r.finish();
