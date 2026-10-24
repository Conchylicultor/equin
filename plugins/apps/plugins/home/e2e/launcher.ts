// Verifies the Home app launcher end to end: one squircle tile per app with a
// flat fill (Settings grey), `/` focuses the capsule search and Escape clears
// it, the view chip's menu opens View settings, drag-to-reorder persists across
// a reload (and is restored afterwards), clicking a tile opens that app, and
// the capsule folds its controls on a narrow pane / gives way to the DataView
// compact fold on a very narrow one.
//
// Usage:
//   ./equin run plugins/apps/plugins/home/e2e/launcher.ts [--headed] [--url http://<ns>.localhost:9000]

import type { Page } from "playwright";
import {
  ELEMENT_TIMEOUT_MS,
  pathUrl,
  report,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const TILE = "[data-row-key]";
const SEARCH = "input[placeholder='Search apps']";
const CAPSULE = "[class*='@container/capsule']";

const r = report("home launcher");

/** Open /home and wait for the tiles (cold start can take ~10s). */
async function openHome(page: Page): Promise<void> {
  await page.goto(pathUrl("/home"), { waitUntil: "domcontentloaded" });
  await page
    .locator(TILE)
    .first()
    .waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
}

/** The visible tiles' row keys, in DOM (= display) order. */
function tileKeys(page: Page): Promise<string[]> {
  return page
    .locator(TILE)
    .evaluateAll((els) =>
      els
        .filter((e) => (e as HTMLElement).getBoundingClientRect().width > 0)
        .map((e) => e.getAttribute("data-row-key") ?? ""),
    );
}

/** Wait until the tile order stabilises to something satisfying `pred`. */
async function waitOrder(
  page: Page,
  pred: (keys: string[]) => boolean,
  timeoutMs = 15_000,
) {
  return waitFor(() => tileKeys(page), pred, { timeoutMs });
}

/** Drag tile `from` onto the given half of tile `to`, with stepwise moves. */
async function dragTile(
  page: Page,
  from: string,
  to: string,
  half: "left" | "right",
): Promise<void> {
  const src = await page
    .locator(`${TILE}[data-row-key="${from}"]`)
    .boundingBox();
  const dst = await page.locator(`${TILE}[data-row-key="${to}"]`).boundingBox();
  if (!src || !dst) throw new Error(`no box for ${from} or ${to}`);
  const sx = src.x + src.width / 2;
  const sy = src.y + src.height / 3;
  const tx = dst.x + dst.width * (half === "right" ? 0.8 : 0.2);
  const ty = dst.y + dst.height / 3;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  // Past dnd-kit's activation distance first, then glide to the target.
  await page.mouse.move(sx + 8, sy + 2, { steps: 4 });
  await page.mouse.move(tx, ty, { steps: 25 });
  await page.mouse.move(tx + 1, ty, { steps: 2 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

/** Parse `oklch(L C H)` / `rgb(...)` into chroma-ish number. */
function chromaOf(color: string): number {
  const ok = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(color);
  if (ok) return Number(ok[2]);
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color);
  if (rgb) {
    const v = [rgb[1], rgb[2], rgb[3]].map(Number);
    return (Math.max(...v) - Math.min(...v)) / 255 / 2.5;
  }
  throw new Error(`unparsed colour ${color}`);
}

await withBrowser(async (h) => {
  const { page, captured } = await h.session({
    colorScheme: "dark",
    viewport: { width: 1280, height: 900 },
  });

  // ── 1. tiles ──────────────────────────────────────────────────────────────
  await openHome(page);
  const tiles = await page.locator(TILE).evaluateAll((els) =>
    els.map((e) => {
      const av = e.querySelector<HTMLElement>(".rounded-squircle");
      const cs = av ? getComputedStyle(av) : null;
      return {
        key: e.getAttribute("data-row-key") ?? "",
        name: e.textContent ?? "",
        squircle: av !== null,
        radius: cs?.borderRadius ?? "",
        bg: cs?.backgroundColor ?? "",
        bgImage: cs?.backgroundImage ?? "",
        width: av?.getBoundingClientRect().width ?? 0,
      };
    }),
  );
  r.note(`tiles: ${tiles.map((t) => `${t.key}=${t.bg}`).join(", ")}`);
  r.ok("1a one tile per app (>= 10)", tiles.length >= 10, `${tiles.length}`);
  const keys = tiles.map((t) => t.key);
  r.ok("1b tile keys unique", new Set(keys).size === keys.length);
  r.ok(
    "1c every tile avatar is a 26% squircle",
    tiles.every((t) => t.squircle && t.radius === "26%" && t.width > 40),
    JSON.stringify(tiles.filter((t) => !(t.squircle && t.radius === "26%"))),
  );
  r.ok(
    "1d every tile has a flat, opaque fill",
    tiles.every(
      (t) =>
        t.bgImage === "none" &&
        !/\/\s*0?\.\d|rgba?\(.*,\s*0?\.\d+\)/.test(t.bg),
    ),
    JSON.stringify(tiles.map((t) => t.bg)),
  );
  const settings = tiles.find((t) => t.key === "settings");
  const others = tiles.filter((t) => t.key !== "settings");
  if (!settings) {
    r.fail("1e settings tile present");
  } else {
    r.ok(
      "1e settings tile is grey (low chroma)",
      chromaOf(settings.bg) < 0.04,
      settings.bg,
    );
    r.ok(
      "1f settings fill differs from every other tile",
      others.every((t) => t.bg !== settings.bg && chromaOf(t.bg) > 0.04),
      JSON.stringify(others.map((t) => t.bg)),
    );
  }
  const distinct = new Set(tiles.map((t) => t.bg)).size;
  r.note(`distinct tile fills: ${distinct} for ${tiles.length} tiles`);

  // ── 2. `/` search ─────────────────────────────────────────────────────────
  await page.getByRole("heading", { name: "Apps" }).click();
  await page.keyboard.press("/");
  const focused = await waitFor(
    () =>
      page.evaluate(
        (sel) => document.activeElement?.matches(sel) ?? false,
        SEARCH,
      ),
    (v) => v,
    { timeoutMs: 3000 },
  );
  r.ok("2a `/` focuses the capsule search", focused.value);
  await page.keyboard.type("set");
  const filtered = await waitOrder(page, (k) => k.length === 1);
  r.eq("2b 'set' leaves only Settings", filtered.value, ["settings"]);
  await page.keyboard.press("Escape");
  const cleared = await waitOrder(page, (k) => k.length === tiles.length);
  r.eq("2c Escape returns all tiles", cleared.value.length, tiles.length);
  r.eq(
    "2d Escape clears the query",
    await page.locator(SEARCH).inputValue(),
    "",
  );
  r.ok(
    "2e Escape blurs the search",
    !(await page.evaluate(
      (sel) => document.activeElement?.matches(sel) ?? false,
      SEARCH,
    )),
  );

  // ── 3. view chip menu ─────────────────────────────────────────────────────
  await page.getByRole("button", { name: /^View: / }).click();
  const menu = page.getByRole("menu");
  await menu.waitFor({ state: "visible", timeout: 5000 });
  r.ok("3a view chip opens a menu", await menu.isVisible());
  await page.getByRole("menuitem", { name: /View settings/ }).click();
  const panel = page.locator("[aria-label='Apps settings']");
  const panelOpen = await waitFor(
    () => panel.isVisible(),
    (v) => v,
    { timeoutMs: 5000 },
  );
  r.ok("3b 'View settings…' opens the settings panel", panelOpen.value);
  await page.keyboard.press("Escape");
  const panelClosed = await waitFor(
    async () => (await panel.count()) === 0 || !(await panel.isVisible()),
    (v) => v,
    { timeoutMs: 5000 },
  );
  r.ok("3c Escape closes the settings panel", panelClosed.value);

  // ── 4. drag to reorder ────────────────────────────────────────────────────
  const original = await tileKeys(page);
  const [a, b, c] = original;
  if (!a || !b || !c) throw new Error("need at least three tiles");
  await dragTile(page, a, c, "right");
  const expected = [b, c, a, ...original.slice(3)];
  const moved = await waitOrder(
    page,
    (k) => JSON.stringify(k) === JSON.stringify(expected),
  );
  r.eq(
    "4a dropping tile 1 on tile 3's right half reorders",
    moved.value,
    expected,
  );
  // Let the debounced order write land before reloading.
  await page.waitForTimeout(1500);
  await openHome(page);
  const afterReload = await waitOrder(
    page,
    (k) => JSON.stringify(k) === JSON.stringify(expected),
  );
  r.eq("4b new order persists across reload", afterReload.value, expected);

  // Restore: drop `a` back on the left half of the (now first) tile `b`.
  await dragTile(page, a, b, "left");
  const restored = await waitOrder(
    page,
    (k) => JSON.stringify(k) === JSON.stringify(original),
  );
  r.eq(
    "4c dragging back restores the original order",
    restored.value,
    original,
  );
  await page.waitForTimeout(1500);
  await openHome(page);
  const restoredReload = await waitOrder(
    page,
    (k) => JSON.stringify(k) === JSON.stringify(original),
  );
  r.eq(
    "4d original order persists across reload",
    restoredReload.value,
    original,
  );

  // ── 5. tile click opens the app ───────────────────────────────────────────
  await page.locator(`${TILE}[data-row-key="settings"]`).click();
  const nav = await waitFor(
    () => Promise.resolve(new URL(page.url()).pathname),
    (p) => p.startsWith("/settings"),
    { timeoutMs: 15_000 },
  );
  r.ok(
    "5a clicking Settings navigates into Settings",
    nav.value.startsWith("/settings"),
    nav.value,
  );
  // The strip's wrapper carries the app id; the active variant marks itself
  // `aria-pressed` (chip) — read whichever tab holds the pressed control.
  const activeTab = await waitFor(
    () =>
      page.evaluate(() =>
        [...document.querySelectorAll("[data-app-tab]")]
          .filter((t) => t.querySelector("[aria-pressed='true']") !== null)
          .map((t) => t.getAttribute("data-app-tab")),
      ),
    (v) => v.length === 1 && v[0] === "settings",
    { timeoutMs: 10_000 },
  );
  r.eq("5b focused tab is the Settings app", activeTab.value, ["settings"]);

  const errors = [...captured.consoleErrors, ...captured.pageErrors];
  r.note(`console/page errors: ${errors.length ? errors.join(" | ") : "none"}`);
  await page.context().close();

  // ── 6. narrow widths ──────────────────────────────────────────────────────
  // The capsule folds its three control circles into one below 560px of its
  // OWN width (a container query), and the DataView drops the capsule for its
  // compact fold below 360px. 700 keeps the circles (capsule ≈ 596px); 520
  // folds them (capsule ≈ 416px, DataView still above 360px); 340 is compact.
  for (const width of [700, 520, 340]) {
    const s = await h.session({
      colorScheme: "dark",
      viewport: { width, height: 900 },
    });
    await openHome(s.page);
    const shape = await s.page.evaluate((sel) => {
      const visible = (el: Element | null) =>
        el !== null && (el as HTMLElement).getBoundingClientRect().width > 0;
      const cap = document.querySelector(sel);
      const btn = (label: string) =>
        [...document.querySelectorAll(`button[aria-label='${label}']`)].filter(
          (b) =>
            visible(b) &&
            (b.getAttribute("data-ui-owner") ?? "").match(
              /ControlTrigger|CompactControls|CreatorsControl/,
            ),
        ).length;
      return {
        capsule: visible(cap),
        capsuleWidth: cap ? Math.round(cap.getBoundingClientRect().width) : 0,
        filter: btn("Filter"),
        sort: btn("Sort"),
        viewSettings: btn("View settings"),
        folded: btn("View options"),
        search: visible(
          document.querySelector("input[placeholder='Search apps']"),
        ),
      };
    }, CAPSULE);
    r.note(`width ${width}: ${JSON.stringify(shape)}`);
    const circles = shape.filter + shape.sort + shape.viewSettings;
    if (width === 700) {
      r.ok("6a @700 capsule renders", shape.capsule);
      r.ok(
        "6b @700 capsule is at least 560px wide",
        shape.capsuleWidth >= 560,
        `${shape.capsuleWidth}px`,
      );
      r.eq("6c @700 the three control circles are visible", circles, 3);
      r.eq("6d @700 no folded control", shape.folded, 0);
    } else if (width === 520) {
      r.ok("6e @520 capsule renders (not the compact fold)", shape.capsule);
      r.ok(
        "6f @520 capsule is narrower than 560px",
        shape.capsuleWidth > 0 && shape.capsuleWidth < 560,
        `${shape.capsuleWidth}px`,
      );
      r.eq("6g @520 the three control circles are hidden", circles, 0);
      r.eq("6h @520 one folded control shown", shape.folded, 1);
      r.ok("6i @520 search stays in the capsule", shape.search);
    } else {
      r.ok("6j @340 capsule not rendered (compact fold)", !shape.capsule);
      r.eq(
        "6k @340 compact fold's View options control shown",
        shape.folded,
        1,
      );
      // The fold's trigger is hover-revealed off its toolbar row: until the
      // row is pointed at, the trigger takes no pointer events and the row
      // receives the click. Point at the row first, as a user does.
      const foldTrigger = s.page.locator(
        "button[aria-label='View options'][data-ui-owner^='CompactControls']",
      );
      await foldTrigger.locator("xpath=..").hover();
      await foldTrigger.click();
      const inPanel = await waitFor(
        () =>
          s.page.evaluate(() => {
            const input = document.querySelector<HTMLElement>(
              "input[placeholder='Search apps']",
            );
            if (!input || input.getBoundingClientRect().width === 0)
              return "no visible search input";
            const popup = input.closest(
              "[role='dialog'],[data-slot='popover-content'],[data-side]",
            );
            return popup ? "in-panel" : "outside any popup";
          }),
        (v) => v === "in-panel",
        { timeoutMs: 5000 },
      );
      r.eq(
        "6l @340 View options panel holds the search field",
        inPanel.value,
        "in-panel",
      );
    }
    await s.context.close();
  }

  await r.finish();
});
