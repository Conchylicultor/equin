// Verifies the landing page's chrome and motion against the Launch mock
// (`proto-1788797350-gqju`, theme=launch): what a pixel diff at rest cannot see.
//
//   - the floating header is clear with no rule at the top, and masked with its
//     rule once the page scrolls under it;
//   - the band hairlines span the reading measure, not the viewport;
//   - the wordmark's full stop sits on the text's line, not above it;
//   - a quiet nav link's hover changes only its colour (no hover box);
//   - the call-to-action pill takes its height and inline padding from the
//     theme's small-control density tokens plus the shape's pill extra, while
//     the quiet nav links at the same size pad without it;
//   - a layer card lifts 3px under the pointer;
//   - the forward arrows (story link, contact call to action) step 4px toward
//     their destination on hover.
//
// Usage:
//   ./equin run plugins/apps/plugins/website/plugins/shell/e2e/site-chrome-verify.ts \
//     [--out /tmp/site-chrome] [--headed]
//
// Manual only — nothing runs this automatically.

import type { Locator, Page } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/site-chrome");

/** The reading measure `website-band.css` declares (65rem at a 16px root). */
const MEASURE_PX = 1040;

/** The header's quiet nav links, in reading order (`header.jsonc`). */
const NAV_WORDS = ["Apps", "Story"];

/** A CSS colour's alpha, from the `rgb()` / `rgba()` / `color()` a computed style returns. */
function alphaOf(color: string): number {
  if (color === "transparent") return 0;
  const slash = /\/\s*([\d.]+)\s*\)$/.exec(color);
  if (slash?.[1] !== undefined) return Number(slash[1]);
  const rgba = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(color);
  if (rgba?.[1] !== undefined) return Number(rgba[1]);
  return 1;
}

/**
 * The x offset of a computed `translate` (`"4px"`, `"4px 0px"`, `"none"`) —
 * the property Tailwind's `translate-x-*` sets, apart from `transform`.
 */
function translatePropX(value: string): number {
  const first = value.trim().split(/\s+/)[0];
  return first === undefined || first === "none" ? 0 : parseFloat(first);
}

/** The translate a computed `transform` matrix carries, `[x, y]`. */
function translateOf(transform: string): [number, number] {
  const m = /^matrix\(([^)]*)\)$/.exec(transform);
  if (!m?.[1]) return [0, 0];
  const parts = m[1].split(",").map((s) => Number(s.trim()));
  return [parts[4] ?? 0, parts[5] ?? 0];
}

/** The pinned header box and its bar, read as colours. */
async function headerPaint(
  page: Page,
): Promise<{ background: string; rule: string; found: boolean }> {
  return page.evaluate(() => {
    const story = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Story",
    );
    let el: HTMLElement | null = story ?? null;
    while (el && getComputedStyle(el).position !== "sticky") {
      el = el.parentElement;
    }
    const bar = el?.firstElementChild;
    if (!el || !(bar instanceof HTMLElement)) {
      return { background: "", rule: "", found: false };
    }
    return {
      background: getComputedStyle(el).backgroundColor,
      rule: getComputedStyle(bar).borderBottomColor,
      found: true,
    };
  });
}

async function computed(loc: Locator, prop: string): Promise<string> {
  return loc.evaluate(
    (el, p) => getComputedStyle(el).getPropertyValue(p),
    prop,
  );
}

await withBrowser(async (h) => {
  const r = report("website chrome & motion");
  const { page } = await h.session({
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
  });
  await boot(page, pathUrl("/website"), {
    marker: "text=Curious how equin came to be?",
    settleMs: 800,
  });

  // --- header at rest: clear, no rule --------------------------------------
  const atRest = await headerPaint(page);
  r.ok("the header is pinned inside the page's scroll", atRest.found);
  r.ok(
    "at the top the header paints no background",
    alphaOf(atRest.background) === 0,
    atRest.background,
  );
  r.ok(
    "at the top the header draws no rule",
    alphaOf(atRest.rule) === 0,
    atRest.rule,
  );
  await snap(page, out, "top");

  // --- the wordmark's full stop ---------------------------------------------
  // Compared glyph-run to glyph-run: the word's own text node (a Range) against
  // the stop's inline box — two runs of one font share a bottom exactly when
  // they share a baseline. The word's ELEMENT box is its line-height box, taller.
  const dot = await page.evaluate(() => {
    const stop = [...document.querySelectorAll("span")].find(
      (s) => s.textContent === "." && s.parentElement?.textContent === "equin.",
    );
    const text = stop?.parentElement?.firstChild;
    if (!stop || !text) return null;
    const range = document.createRange();
    range.selectNodeContents(text);
    return {
      dot: stop.getBoundingClientRect().bottom,
      word: range.getBoundingClientRect().bottom,
      display: getComputedStyle(stop).display,
    };
  });
  r.ok(
    "the wordmark's full stop sits on the word's line",
    dot !== null &&
      dot.display === "inline" &&
      Math.abs(dot.dot - dot.word) <= 1,
    JSON.stringify(dot),
  );

  // --- nav link hover: colour only -------------------------------------------
  const appsLink = page.getByRole("button", { name: "Apps", exact: true });
  await appsLink.hover();
  await page.waitForTimeout(250);
  const navBg = await computed(appsLink, "background-color");
  r.ok("a quiet nav link paints no hover box", alphaOf(navBg) === 0, navBg);

  // --- the call to action's width comes from the theme -----------------------
  // The pill is a small control: its height is the equin density preset's
  // small-control height (38.4px), and its inline padding that size's 12px plus
  // the shape's 6px pill extra on each rounded end — 18px, not Button's own.
  // The app's own action bar has an "Improve" button too (a tooltip trigger);
  // the site's is the one that opens its panel (a popover trigger).
  const cta = page
    .getByRole("button", { name: "Improve", exact: true })
    .and(page.locator('[data-slot="popover-trigger"]'));
  const ctaBox = await cta.evaluate((el) => {
    const s = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      padStart: s.paddingInlineStart,
      padEnd: s.paddingInlineEnd,
      height: rect.height,
      width: rect.width,
    };
  });
  r.ok(
    "the call to action's inline padding is 18px (12px + the 6px pill extra)",
    ctaBox.padStart === "18px" && ctaBox.padEnd === "18px",
    JSON.stringify(ctaBox),
  );
  r.ok(
    "the call to action's height is the preset's 38.4px",
    Math.abs(ctaBox.height - 38.4) < 0.5,
    `${ctaBox.height}px`,
  );

  // --- a quiet link pads less than the pill beside it -----------------------
  // Same small size, two shapes: the ghost links take the preset's 12px, and the
  // pill adds the shape group's 6px pill extra on each rounded end. So the nav
  // words sit the mock's ~29px apart (12 + 4px gap + 12) while the pill keeps 18.
  const linkPad = await computed(appsLink, "padding-inline-start");
  r.ok(
    "a quiet nav link's inline padding is 12px",
    linkPad === "12px",
    linkPad,
  );
  // Word to word, not box to box: each label's glyph run (a Range over the
  // button's contents), so the gap is the padding either side plus the gap
  // between the two buttons — what a reader sees between the words.
  const wordGaps = await page.evaluate((labels) => {
    const words = labels.map((label) => {
      const button = [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === label,
      );
      if (!button) return null;
      const range = document.createRange();
      range.selectNodeContents(button);
      return range.getBoundingClientRect();
    });
    const gaps: number[] = [];
    for (let i = 1; i < words.length; i++) {
      const before = words[i - 1];
      const after = words[i];
      if (!before || !after) return null;
      gaps.push(Math.round(after.left - before.right));
    }
    return gaps;
  }, NAV_WORDS);
  r.ok(
    "the quiet nav words sit about the mock's 29px apart",
    wordGaps !== null &&
      wordGaps.length > 0 &&
      wordGaps.every((g) => g >= 26 && g <= 31),
    JSON.stringify(wordGaps),
  );

  // --- band hairlines span the measure ----------------------------------------
  // A hairline is a top border alone — a card's all-round border is not one.
  const rules = await page.evaluate(() =>
    [...document.querySelectorAll("section, footer")]
      .flatMap((band) => [band, ...band.querySelectorAll("div")])
      .filter((el) => {
        const s = getComputedStyle(el);
        return s.borderTopWidth === "1px" && s.borderLeftWidth === "0px";
      })
      .map((el) => Math.round(el.getBoundingClientRect().width)),
  );
  r.ok(
    "every band hairline is as wide as the reading measure",
    rules.length > 0 && rules.every((w) => w === MEASURE_PX),
    `widths ${rules.join(", ")}px, measure ${MEASURE_PX}px`,
  );

  // --- layer card lift -------------------------------------------------------
  const card = page.getByRole("button", { name: /The technical foundations/ });
  await card.scrollIntoViewIfNeeded();
  await card.hover();
  const lifted = await waitFor(
    async () => translateOf(await computed(card, "transform"))[1],
    (y) => Math.abs(y + 3) < 0.01,
    { timeoutMs: 2000, intervalMs: 50 },
  );
  r.ok(
    "a layer card lifts 3px under the pointer",
    lifted.ok,
    `translateY ${lifted.value}px`,
  );
  await snap(page, out, "card-hover");

  // --- forward arrows ---------------------------------------------------------
  for (const [what, control] of [
    [
      "the story link",
      page.getByRole("button", { name: "Read the full story and context" }),
    ],
    [
      "the contact call to action",
      page.getByRole("link", { name: "Get in touch" }),
    ],
  ] as const) {
    await control.scrollIntoViewIfNeeded();
    await control.hover();
    const arrow = control.locator("svg");
    const nudged = await waitFor(
      async () => translatePropX(await computed(arrow, "translate")),
      (x) => Math.abs(x - 4) < 0.01,
      { timeoutMs: 2000, intervalMs: 50 },
    );
    r.ok(
      `${what}'s arrow steps 4px on hover`,
      nudged.ok,
      `translate-x ${nudged.value}px`,
    );
  }

  // --- header once scrolled: masked, rule drawn ------------------------------
  await page.mouse.move(640, 450);
  await page.mouse.wheel(0, 600);
  const scrolled = await waitFor(
    () => headerPaint(page),
    (p) => alphaOf(p.background) > 0 && alphaOf(p.rule) > 0,
    { timeoutMs: 3000, intervalMs: 100 },
  );
  r.ok(
    "scrolled, the header masks the page and draws its rule",
    scrolled.ok,
    JSON.stringify(scrolled.value),
  );
  await snap(page, out, "scrolled");

  // --- and back to the top: clear again ---------------------------------------
  await page.mouse.wheel(0, -2000);
  const back = await waitFor(
    () => headerPaint(page),
    (p) => alphaOf(p.background) === 0 && alphaOf(p.rule) === 0,
    { timeoutMs: 3000, intervalMs: 100 },
  );
  r.ok(
    "back at the top, the header is clear again",
    back.ok,
    JSON.stringify(back.value),
  );

  await r.finish();
});
