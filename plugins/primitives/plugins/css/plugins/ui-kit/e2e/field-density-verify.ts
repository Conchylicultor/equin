// Reads back the size every field (ui-kit `Input` / `SelectTrigger`) renders at
// on a screen, beside the buttons in its row.
//
// Fields and buttons read the same per-size density tokens, so in one row they
// should share a height. This lists each field's computed height, inline
// padding and font size, and the heights of the buttons that share its nearest
// row container — a field whose height differs from every button beside it is
// flagged.
//
// Usage:
//   ./equin run plugins/primitives/plugins/css/plugins/ui-kit/e2e/field-density-verify.ts --path /settings
//   … --click "Filter"   (open a popover first; matches a button's accessible name)

import {
  arg,
  numArg,
  pageUrl,
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

interface FieldSample {
  slot: string;
  label: string;
  height: number;
  padStart: string;
  padEnd: string;
  fontSize: string;
  rowButtonHeights: number[];
}

const url = pageUrl("/");
const click = arg("click");

await withBrowser(async (h) => {
  const { page } = await h.session();
  await page.goto(url);
  await page.waitForTimeout(numArg("wait", 3000));
  if (click) {
    await page.getByRole("button", { name: click }).first().click();
    await page.waitForTimeout(1000);
  }

  const samples: FieldSample[] = await page.evaluate(() => {
    const out: FieldSample[] = [];
    const fields = document.querySelectorAll(
      '[data-slot="input"], [data-slot="sidebar-input"], [data-slot="select-trigger"]',
    );
    for (const el of Array.from(fields)) {
      const box = el.getBoundingClientRect();
      if (box.width === 0) continue;
      const cs = getComputedStyle(el);
      // The nearest ancestor holding a button ON THE SAME LINE (its vertical
      // centre inside the field's box): the field's row.
      const mid = (r: DOMRect) => r.top + r.height / 2;
      const onLine = (b: Element) => {
        const m = mid(b.getBoundingClientRect());
        return m >= box.top && m <= box.bottom;
      };
      let row: Element | null = el.parentElement;
      let buttons: Element[] = [];
      for (let i = 0; row && i < 5; i++, row = row.parentElement) {
        buttons = Array.from(
          row.querySelectorAll('button:not([data-slot="select-trigger"])'),
        ).filter(onLine);
        if (buttons.length > 0) break;
      }
      out.push({
        slot: el.getAttribute("data-slot") ?? "?",
        label:
          el.getAttribute("aria-label") ??
          el.getAttribute("placeholder") ??
          (el.textContent ?? "").trim().slice(0, 30),
        height: Math.round(box.height * 10) / 10,
        padStart: cs.paddingInlineStart,
        padEnd: cs.paddingInlineEnd,
        fontSize: cs.fontSize,
        rowButtonHeights: [
          ...new Set(
            buttons
              .map(
                (b) => Math.round(b.getBoundingClientRect().height * 10) / 10,
              )
              .filter((hgt) => hgt > 0),
          ),
        ],
      });
    }
    return out;
  });

  const r = report(`field-density ${new URL(url).pathname}`);
  let mismatched = 0;
  for (const s of samples) {
    const mismatch =
      s.rowButtonHeights.length > 0 && !s.rowButtonHeights.includes(s.height);
    if (mismatch) mismatched++;
    r.note(
      `${mismatch ? "≠" : " "} ${s.slot.padEnd(15)} h=${s.height} pad=${s.padStart}/${s.padEnd} font=${s.fontSize} row buttons=[${s.rowButtonHeights.join(",")}]  ${s.label}`,
    );
  }
  r.ok("found fields on screen", samples.length > 0);
  r.note(
    `${mismatched} field(s) differ in height from every button in their row`,
  );
  await r.finish();
});
