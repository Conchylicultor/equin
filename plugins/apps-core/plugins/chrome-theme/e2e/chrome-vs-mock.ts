/**
 * The app chrome beside the "App chrome" prototype it was designed from
 * (`proto-1789460441-wknb`, picked options: banner layout, graphite tone,
 * underline tabs, merged Improve, pill shape, outline frame).
 *
 * The prototype Compare stage frames the app chromeless (`?embed=1` — no rail,
 * no tab bar), so it cannot compare the chrome itself. This does it directly:
 * the mock and the running app at the mock's own viewport, the same three
 * regions photographed from each (top-left of the bar, its action cluster, the
 * rail), and the painted values that matter read back from both — ground,
 * text, hairline, bar height, rail button box, pill radius and fill, and the
 * type the tab and pill labels are set in (size, weight, smoothing).
 *
 * Also asserts what the chrome must be regardless of the mock: it wears the
 * fixed chrome theme, and switching to an app with its own theme leaves the
 * chrome's ground untouched.
 *
 * Manual only. After `./equin build`:
 *
 *   ./equin run plugins/apps-core/plugins/chrome-theme/e2e/chrome-vs-mock.ts [--out /tmp/chrome] [--color-scheme dark|light]
 */
import type { Page } from "playwright";
import {
  arg,
  pathUrl,
  report,
  withBrowser,
  detectOsColorScheme,
  type ColorScheme,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const PROTO = "proto-1789460441-wknb";
const PICKS =
  "layout=banner&tone=graphite&tabs=underline&improve=merged&shape=pill&frame=outline&build=idle&font=inter";
const VIEWPORT = { width: 1320, height: 860 };
const out = arg("out", "/tmp/chrome-vs-mock");
const colorScheme = (arg("color-scheme") ??
  detectOsColorScheme()) as ColorScheme;

const r = report("chrome-vs-mock");

/** The regions photographed from both pages, in CSS px. */
const REGIONS = {
  "bar-left": { x: 0, y: 0, width: 520, height: 44 },
  "bar-right": { x: VIEWPORT.width - 520, y: 0, width: 520, height: 44 },
  rail: { x: 0, y: 0, width: 48, height: VIEWPORT.height },
};

async function shoot(page: Page, side: "mock" | "app") {
  for (const [name, clip] of Object.entries(REGIONS)) {
    const path = `${out}-${side}-${name}.png`;
    await page.screenshot({ path, clip });
    console.log(`wrote ${path}`);
  }
  const full = `${out}-${side}-full.png`;
  await page.screenshot({ path: full });
  console.log(`wrote ${full}`);
}

/**
 * The painted values of the first element matching `selector`. Colours are
 * read back as the sRGB bytes a canvas paints them as, so the mock's hex and
 * the app's oklch tokens compare as the colours they are, not as spellings.
 * The background is the COMPOSITED one — every ancestor's fill painted under
 * the element's own — so a translucent fill (the mock's `rgba(255,255,255,.11)`
 * selected tone) compares as what is on screen.
 */
async function paint(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const ctx = document.createElement("canvas").getContext("2d")!;
    const rgb = (color: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return a === 0 ? "transparent" : `rgb(${r}, ${g}, ${b})`;
    };
    const composited = () => {
      const chain: Element[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
      ctx.clearRect(0, 0, 1, 1);
      for (const e of chain) {
        ctx.fillStyle = getComputedStyle(e).backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
      }
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return `rgb(${r}, ${g}, ${b})`;
    };
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      bg: composited(),
      fg: rgb(cs.color),
      border: rgb(cs.borderBottomColor),
      radius: cs.borderTopLeftRadius,
      w: Math.round(box.width),
      h: Math.round(box.height),
      // The type the words are set in. Smoothing matters as much as weight:
      // `auto` thickens light-on-dark stems on macOS.
      font: `${cs.fontSize} ${cs.fontWeight} ${cs.getPropertyValue("-webkit-font-smoothing")}`,
    };
  }, selector);
}

/** Two `rgb(…)` readings within `tolerance` per channel (rounding in the two colour paths). */
function near(a: string | undefined, b: string | undefined, tolerance = 2) {
  const channels = (c: string | undefined) =>
    c?.match(/\d+/g)?.map(Number) ?? [];
  const [x, y] = [channels(a), channels(b)];
  return (
    x.length === 3 &&
    y.length === 3 &&
    x.every((v, i) => Math.abs(v - y[i]!) <= tolerance)
  );
}

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: VIEWPORT, colorScheme });

  // ── the mock ──
  await page.goto(pathUrl(`/api/prototypes/${PROTO}/index.html?${PICKS}`));
  await page.waitForTimeout(1500);
  await shoot(page, "mock");
  const mock = {
    bar: await paint(page, ".bar"),
    rail: await paint(page, ".rail"),
    railBtn: await paint(page, ".rail-btn.active"),
    tab: await paint(page, ".tab.active"),
    tabLabel: await paint(page, ".tab.active .t"),
    pill: await paint(page, ".split.improve"),
    pillLabel: await paint(page, ".split.improve .btn.main"),
    pickSegment: await paint(page, ".split.improve .seg"),
  };
  console.log("mock:", JSON.stringify(mock, null, 2));

  // ── the app ──
  await page.goto(pathUrl("/home"));
  await page.waitForTimeout(5000);
  await shoot(page, "app");
  const CHROME = '[data-theme-scope="fixed:chrome"]';
  const app = {
    bar: await paint(page, `${CHROME}:has([data-app-tab])`),
    rail: await paint(page, `${CHROME}:has(button[aria-label="Home"])`),
    railBtn: await paint(page, `${CHROME} button[aria-label="Home"]`),
    tab: await paint(page, '[data-app-tab] [aria-pressed="true"]'),
    tabLabel: await paint(
      page,
      '[data-app-tab] [aria-pressed="true"] .text-control',
    ),
    pill: await paint(
      page,
      '[data-slot="button-group"]:has(button[aria-label="Pick UI element"])',
    ),
    pickSegment: await paint(page, 'button[aria-label="Pick UI element"]'),
    // The group draws no frame of its own — its segments do.
    pillSegment: await paint(
      page,
      '[data-slot="button-group"]:has(button[aria-label="Pick UI element"]) > button',
    ),
  };
  console.log("app:", JSON.stringify(app, null, 2));

  r.ok("the tab bar wears the chrome theme", app.bar !== null);
  r.ok("the rail wears the chrome theme", app.rail !== null);
  r.eq("bar ground matches the mock", app.bar?.bg, mock.bar?.bg);
  r.eq("rail ground matches the mock", app.rail?.bg, mock.rail?.bg);
  r.eq("bar height matches the mock", app.bar?.h, mock.bar?.h);
  r.eq("hairline matches the mock", app.bar?.border, mock.bar?.border);
  r.eq("active tab text matches the mock", app.tab?.fg, mock.tab?.fg);
  r.eq(
    "tab label type matches the mock",
    app.tabLabel?.font,
    mock.tabLabel?.font,
  );
  r.eq("rail button box matches the mock", app.railBtn?.w, mock.railBtn?.w);
  r.eq(
    "rail button corner matches the mock",
    app.railBtn?.radius,
    mock.railBtn?.radius,
  );
  r.ok(
    "selected app tone matches the mock",
    near(app.railBtn?.bg, mock.railBtn?.bg),
    `${app.railBtn?.bg} vs ${mock.railBtn?.bg}`,
  );
  r.ok("Improve and Pick share one pill", app.pill !== null);
  r.eq("pill height matches the mock", app.pill?.h, mock.pill?.h);
  r.eq(
    "pill frame matches the mock",
    app.pillSegment?.border,
    mock.pill?.border,
  );
  // The pill has no fill of its own: what shows through is the bar's ground.
  r.eq("pill fill matches the mock", app.pillSegment?.bg, mock.pill?.bg);
  r.eq(
    "pill label type matches the mock",
    app.pillSegment?.font,
    mock.pillLabel?.font,
  );
  r.eq(
    "Pick segment keeps the quieter tone",
    app.pickSegment?.fg,
    mock.pickSegment?.fg,
  );
  r.ok(
    "pill ends are fully round",
    parseFloat(app.pillSegment?.radius ?? "0") >= (app.pill?.h ?? 0) / 2,
    app.pillSegment?.radius,
  );

  // ── the chrome is constant across apps ──
  // Switch the focused tab to the website, the app with its own theme, and
  // read the chrome again: its ground must not move.
  await page.goto(pathUrl("/website"));
  await page.waitForTimeout(4000);
  const onWebsite = await paint(page, `${CHROME}:has([data-app-tab])`);
  r.eq(
    "the chrome keeps its ground on an app with its own theme",
    onWebsite?.bg,
    app.bar?.bg,
  );
  await page.screenshot({ path: `${out}-app-website.png` });
  console.log(`wrote ${out}-app-website.png`);
});

await r.finish();
