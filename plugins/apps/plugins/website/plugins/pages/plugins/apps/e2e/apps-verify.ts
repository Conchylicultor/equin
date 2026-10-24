// Verifies the Apps page's measured geometry and type against its mock
// (`proto-1790867857-hug2`, end-cards=question, measure=site-1040,
// icons=palette-deep) — what a first-screen pixel diff cannot reach: computed
// sizes, weights and paddings, and the closing block and footer below the fold.
//
//   - the site header's wordmark and nav sit on the 1040px measure's edges;
//   - chips, cards, Install, search, group heads and the card's words carry
//     the mock's sizes;
//   - "Missing an app?", the read-next cards and the footer keep the mock's
//     paddings, corners and distances.
//
// Usage:
//   ./equin run plugins/apps/plugins/website/plugins/pages/plugins/apps/e2e/apps-verify.ts \
//     [--out /tmp/apps-verify] [--headed]
//
// Manual only — nothing runs this automatically.

import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { withBrowser } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/apps-verify");

const VIEWPORT = { width: 1920, height: 1080 };
/** The reading measure `website-band.css` declares (65rem at a 16px root). */
const MEASURE_PX = 1040;

interface Measured {
  w: number;
  h: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  padding: string;
  radius: string;
  color: string;
  borderColor: string;
}

/** Within half a pixel. */
const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;

await withBrowser(async (h) => {
  const r = report("website apps page vs its mock");
  const { page } = await h.session({ viewport: VIEWPORT, colorScheme: "dark" });
  await boot(page, pathUrl("/website/apps"), {
    marker: "text=The harness",
    settleMs: 800,
  });

  /** The innermost element whose own text is `text`, matched by `tag`, measured. */
  const measure = (tag: string, text: string, up = 0) =>
    page.evaluate(
      ({ tag, text, up }) => {
        const hit = [...document.querySelectorAll<HTMLElement>(tag)].find(
          (el) => el.textContent?.trim() === text,
        );
        if (!hit) return null;
        let el: HTMLElement = hit;
        for (let i = 0; i < up && el.parentElement; i++) el = el.parentElement;
        const b = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return {
          w: b.width,
          h: b.height,
          left: b.left,
          right: b.right,
          top: b.top,
          bottom: b.bottom,
          fontSize: s.fontSize,
          fontWeight: s.fontWeight,
          lineHeight: s.lineHeight,
          padding: s.padding,
          radius: s.borderTopLeftRadius,
          color: s.color,
          borderColor: s.borderTopColor,
        };
      },
      { tag, text, up },
    ) as Promise<Measured | null>;

  const edge = (VIEWPORT.width - MEASURE_PX) / 2;

  // --- header on the measure -------------------------------------------------
  const improve = await measure("button", "Improve");
  r.ok(
    "the header's last control ends on the measure's right edge",
    improve !== null && near(improve.right, VIEWPORT.width - edge, 1),
    JSON.stringify(improve?.right),
  );

  // --- chips -------------------------------------------------------------------
  const chip = await measure("button", "The harness3");
  r.ok(
    "a chip is 13.5px at weight 500, about 35px tall",
    chip !== null &&
      chip.fontSize === "13.5px" &&
      chip.fontWeight === "500" &&
      near(chip.h, 34.93, 0.6),
    JSON.stringify(chip),
  );

  // --- a card --------------------------------------------------------------------
  const name = await measure("h4", "Agent manager");
  r.ok(
    "an app's name is 16px/600",
    name !== null && name.fontSize === "16px" && name.fontWeight === "600",
    JSON.stringify(name),
  );
  const card = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".website-app-card");
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      w: el.getBoundingClientRect().width,
      padding: s.padding,
      radius: s.borderTopLeftRadius,
    };
  });
  r.ok(
    "a card is ~248px wide, 18px inset, 18px corners",
    card !== null &&
      near(card.w, 248, 1) &&
      card.padding === "18px" &&
      card.radius === "18px",
    JSON.stringify(card),
  );
  const install = await measure("button", "Install");
  r.ok(
    "Install is a ~31px pill at 12.5px/600",
    install !== null &&
      install.fontSize === "12.5px" &&
      install.fontWeight === "600" &&
      near(install.h, 31.375, 0.6),
    JSON.stringify(install),
  );
  const group = await measure("h3", "The harness");
  r.ok(
    "a group's name is 20px/600",
    group !== null && group.fontSize === "20px" && group.fontWeight === "600",
    JSON.stringify(group),
  );

  // --- search ------------------------------------------------------------------
  const search = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".website-apps-search");
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {
      w: b.width,
      h: b.height,
      radius: getComputedStyle(el).borderTopLeftRadius,
    };
  });
  r.ok(
    "the search field is 560 × 50 with 14px corners",
    search !== null &&
      near(search.w, 560) &&
      near(search.h, 50) &&
      search.radius === "14px",
    JSON.stringify(search),
  );

  // --- the page's end ------------------------------------------------------------
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await page.mouse.wheel(0, 10_000);
  await page.waitForTimeout(600);
  const compose = await measure("h3", "Missing an app?", 0);
  const composeCard = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".website-apps-compose");
    if (!el) return null;
    const s = getComputedStyle(el);
    const field = el.querySelector<HTMLElement>("input");
    return {
      padding: s.padding,
      radius: s.borderTopLeftRadius,
      field: field?.getBoundingClientRect().height ?? 0,
    };
  });
  r.ok(
    '"Missing an app?" is 20px, its card 30 × 34px inset with 22px corners and a 42px field',
    compose !== null &&
      compose.fontSize === "20px" &&
      composeCard !== null &&
      composeCard.padding === "30px 34px" &&
      composeCard.radius === "22px" &&
      near(composeCard.field, 42),
    JSON.stringify({ compose, composeCard }),
  );
  const question = await measure("span", "Where is this going?");
  const nextCard = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".website-app-next");
    if (!el) return null;
    const s = getComputedStyle(el);
    return {
      padding: s.padding,
      radius: s.borderTopLeftRadius,
      bottom: el.getBoundingClientRect().bottom,
    };
  });
  r.ok(
    "a read-next card is 26 × 28px inset with 20px corners, its question 19px on a 1.35 line",
    question !== null &&
      question.fontSize === "19px" &&
      near(parseFloat(question.lineHeight), 25.65, 0.1) &&
      nextCard !== null &&
      nextCard.padding === "26px 28px" &&
      nextCard.radius === "20px",
    JSON.stringify({ question, nextCard }),
  );
  const footerRule = await page.evaluate(() => {
    const el = document.querySelector("footer > * > *");
    return el instanceof HTMLElement ? el.getBoundingClientRect().top : null;
  });
  r.ok(
    "the footer's rule sits 64px under the read-next cards",
    footerRule !== null &&
      nextCard !== null &&
      near(footerRule - nextCard.bottom, 64, 1),
    JSON.stringify({ footerRule, cards: nextCard?.bottom }),
  );
  await snap(page, out, "end");

  await r.finish();
});
