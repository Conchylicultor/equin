// Shots 6-9: the Circle prototype (variants, responsive, compare slider), the
// desktop with Circle as a window, the menu-bar panel, and the Foundations
// iceberg as a strip.

import type { Page } from "playwright";
import {
  type Ctx,
  H,
  W,
  hideBar,
  measure,
  open,
  park,
  rect,
  shot,
  sweepNoise,
} from "./capture-kit";

const PROTO = "proto-1792779833-4wgtuf";

async function domClickNth(p: Page, label: string, n: number): Promise<void> {
  await p.evaluate(
    ([label, n]) => {
      const b = Array.from(
        document.querySelectorAll<HTMLElement>("button"),
      ).filter((x) => x.getAttribute("aria-label") === label)[n];
      if (!b) throw new Error(`button "${label}" #${n} not found`);
      b.click();
    },
    [label, n] as const,
  );
}

async function frames(
  p: Page,
): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  return p.evaluate(() =>
    Array.from(document.querySelectorAll("iframe"))
      .map((f) => f.getBoundingClientRect())
      .filter((r) => r.width > 100)
      .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }))
      .sort((a, b) => a.x - b.x),
  );
}

/** Open the options popover of frame `i` and pick `label` in it (a local, unsaved choice: the persisting write is refused on main). */
async function pickOption(
  p: Page,
  i: number,
  row: string,
  label: string | number,
): Promise<void> {
  await domClickNth(p, "Prototype options", i);
  await p.waitForTimeout(500);
  const ok = await p.evaluate(
    ([row, label]) => {
      const r = Array.from(document.querySelectorAll("*")).find(
        (e) =>
          e.children.length === 0 &&
          e.textContent?.trim() === row &&
          e.getBoundingClientRect().y > 100 &&
          e.getBoundingClientRect().y < 330,
      );
      let line: HTMLElement | null = r as HTMLElement | null;
      while (line && line.querySelectorAll("button").length === 0)
        line = line.parentElement;
      if (!line) return false;
      const bs = Array.from(line.querySelectorAll("button"));
      const b =
        typeof label === "number"
          ? bs[label]
          : bs.find((x) => x.textContent?.trim() === label);
      if (!b) return false;
      (b as HTMLElement).click();
      return true;
    },
    [row, label] as const,
  );
  if (!ok)
    throw new Error(`circle: option ${row}=${label} not found in frame ${i}`);
  await p.waitForTimeout(500);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(400);
}

export async function circleShots(c: Ctx): Promise<void> {
  const p = c.page;
  await open(p, `/prototypes/proto/${PROTO}`);
  await p.waitForFunction(
    () =>
      (document.querySelector("iframe")?.getBoundingClientRect().width ?? 0) >
      300,
    null,
    { timeout: 30_000 },
  );
  await p.waitForTimeout(2500);
  await hideBar(p);
  await park(p, W / 2, H - 3);
  await shot(c, "circle-single");
  const [f0] = await frames(p);
  c.manifest.rects["circle-single-frame"] = f0!;
  await shot(c, "circle-single-frame", f0);
  await rect(
    c,
    "circle-header",
    () =>
      Array.from(document.querySelectorAll("*"))
        .find((e) => e.children.length === 0 && e.textContent === "Prototypes")
        ?.closest("[class*=rounded]") ?? null,
  );
  await rect(
    c,
    "circle-controls",
    () =>
      Array.from(document.querySelectorAll("button")).find(
        (b) => b.getAttribute("aria-label") === "Phone",
      )?.parentElement ?? null,
  );

  // The phone view of a single frame.
  await p.getByRole("button", { name: "Phone", exact: true }).click();
  await p.waitForTimeout(1500);
  await park(p, W / 2, H - 3);
  await shot(c, "circle-single-phone");
  const [ph] = await frames(p);
  c.manifest.rects["circle-single-phone-frame"] = ph!;
  await shot(c, "circle-single-phone-frame", ph);
  await p.getByRole("button", { name: "Responsive", exact: true }).click();
  await p.waitForTimeout(1200);

  // Two variants side by side, light theme.
  // The first frame's options persist (a write main refuses); local frames can be themed, so two
  // added frames become the pair and the original is removed from the canvas.
  await domClickNth(p, "Add a frame to compare", 0);
  await p.waitForTimeout(1500);
  await domClickNth(p, "Remove from canvas", 0);
  await p.waitForTimeout(1500);
  await domClickNth(p, "Add a frame to compare", 0);
  await p.waitForTimeout(1500);
  await pickOption(p, 0, "Theme", "Light");
  await pickOption(p, 1, "Theme", "Light");
  await pickOption(p, 1, "Accent", 1); // the second variant: violet
  await p.waitForTimeout(800);
  const lights = await p.evaluate(
    () =>
      Array.from(document.querySelectorAll("button")).filter((b) =>
        /Online · Light/.test(b.textContent ?? ""),
      ).length,
  );
  // Main refuses the first frame's persisted option write, so it stays dark: the pair is dark vs light.
  console.log(`  circle pair: ${lights} of 2 frames light`);
  await p.addStyleTag({ content: "body{user-select:none!important}" });
  await p.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await pickOption(p, 1, "Accent", 1); // the second variant: violet
  await park(p, W / 2, H - 3);
  await p.waitForTimeout(1200);
  await shot(c, "circle-pair");
  const [a, b] = await frames(p);
  if (!a || !b) throw new Error("circle: the pair did not render two frames");
  c.manifest.rects["circle-pair-a"] = a;
  c.manifest.rects["circle-pair-b"] = b;
  await shot(c, "circle-pair-a", a);
  await shot(c, "circle-pair-b", b);
  await rect(
    c,
    "circle-pair-controls",
    () =>
      Array.from(document.querySelectorAll("button")).find(
        (x) => x.getAttribute("aria-label") === "Phone",
      )?.parentElement ?? null,
  );

  // Responsive: the pair shrinks to phones.
  await p.getByRole("button", { name: "Phone", exact: true }).click();
  await p.waitForTimeout(1800);
  await park(p, W / 2, H - 3);
  await shot(c, "circle-pair-phone");
  const [pa, pb] = await frames(p);
  c.manifest.rects["circle-pair-phone-a"] = pa!;
  c.manifest.rects["circle-pair-phone-b"] = pb!;
  await shot(c, "circle-pair-phone-a", pa);
  await shot(c, "circle-pair-phone-b", pb);
  await p.getByRole("button", { name: "Responsive", exact: true }).click();
  await p.waitForTimeout(1500);

  // The slider: one frame swiped over the other, at four positions.
  await domClickNth(p, "Swipe one frame over the other", 0);
  await p.waitForTimeout(1000);
  const handle = await measure(
    p,
    "slider handle",
    () =>
      Array.from(document.querySelectorAll("button")).find((x) => {
        const r = x.getBoundingClientRect();
        return (
          r.width <= 34 &&
          r.height <= 34 &&
          r.y > 100 &&
          r.y < 200 &&
          r.x > 300 &&
          r.x < 1000
        );
      }) ?? null,
  );
  const [sf] = await frames(p);
  c.manifest.rects["circle-slider-frame"] = sf!;
  const hy = handle.y + handle.height / 2;
  let cur = handle.x + handle.width / 2;
  const positions = [0.15, 0.4, 0.62, 0.85];
  for (let i = 0; i < positions.length; i++) {
    const tx = sf!.x + sf!.width * positions[i]!;
    await p.mouse.move(cur, hy);
    await p.mouse.down();
    await p.mouse.move(tx, hy, { steps: 12 });
    await p.mouse.up();
    cur = tx;
    await p.waitForTimeout(600);
    await shot(c, `circle-slider-${i}`);
    // The divider sits where the pointer let go; the handle is the 30 px button riding it.
    c.manifest.rects[`circle-slider-handle-${i}`] = {
      x: tx - 15,
      y: hy - 15,
      width: 30,
      height: 30,
    };
    c.manifest.rects[`circle-slider-edge-${i}`] = {
      x: tx,
      y: sf!.y,
      width: 1,
      height: sf!.height,
    };
  }
  await sweepNoise(p);
}

/** The rect of the desktop window titled `title`: the first ancestor of its title text big enough to be a window. */
async function windowRect(
  c: Ctx,
  name: string,
  title: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const loc = c.page.getByText(title, { exact: true }).first();
  await loc.waitFor({ state: "visible", timeout: 30_000 });
  const r = await loc.evaluate((el) => {
    let t: Element | null = el;
    while (
      t &&
      (t.getBoundingClientRect().width < 420 ||
        t.getBoundingClientRect().height < 300)
    )
      t = t.parentElement;
    if (!t) throw new Error("no window root");
    const b = t.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
  c.manifest.rects[name] = r;
  return r;
}

async function dragTitle(
  c: Ctx,
  title: string,
  dx: number,
  dy: number,
): Promise<void> {
  const p = c.page;
  const t = await p.getByText(title, { exact: true }).first().boundingBox();
  if (!t) throw new Error(`window title ${title} has no box`);
  const x = t.x + t.width / 2;
  const y = t.y + t.height / 2;
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.mouse.move(x + dx, y + dy, { steps: 14 });
  await p.mouse.up();
  await p.waitForTimeout(500);
}

async function settled(c: Ctx): Promise<void> {
  const p = c.page;
  await p.addStyleTag({ content: "body{user-select:none!important}" });
  await p.waitForFunction(
    () =>
      !/Waiting for the server/.test(document.body.innerText) &&
      document.body.innerText.trim().length > 20,
    null,
    { timeout: 90_000 },
  );
  await p.addStyleTag({
    content:
      '[data-sonner-toaster]{display:none!important}[data-ui-owner^="DeveloperCorner"]{display:none!important}',
  });
  await p.waitForTimeout(2500);
  await sweepNoise(p);
}

export async function desktopShots(c: Ctx): Promise<void> {
  const p = c.page;
  await open(p, "/desktop");
  await settled(c);
  await park(p, W / 2, 200);
  await shot(c, "desktop-empty");
  // The shelf is the fixed bar holding the clock.
  await rect(c, "desktop-shelf", () => {
    const t = Array.from(document.querySelectorAll("*")).find(
      (e) =>
        e.children.length === 0 &&
        /^\d\d:\d\d$/.test(e.textContent?.trim() ?? ""),
    );
    let n: Element | null = t ?? null;
    while (n && n.getBoundingClientRect().width < 500) n = n.parentElement;
    return n;
  });
  // Windows: three apps from the shelf, then Circle (its card in the Prototypes gallery) on top.
  const shelfY = 683;
  await p.mouse.click(484, shelfY); // Pages
  await settled(c);
  await dragTitle(c, "Pages", 330, 40);
  await p.mouse.click(584, shelfY); // Places
  await settled(c);
  await dragTitle(c, "Places", 150, 190);
  await p.mouse.click(434, shelfY); // Prototypes
  await settled(c);
  await p
    .getByText("Circle — P2P friends", { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  await p.getByText("Circle — P2P friends", { exact: true }).first().click();
  await settled(c);
  await dragTitle(c, "Circle — P2P friends", -30, 20);
  await park(p, W / 2, 10);
  await shot(c, "desktop");
  await windowRect(c, "desktop-window-circle", "Circle — P2P friends");
  await windowRect(c, "desktop-window-pages", "Pages");
  await windowRect(c, "desktop-window-places", "Places");
}

export async function macShots(c: Ctx): Promise<void> {
  const panel = await c.context.newPage();
  await panel.setViewportSize({ width: 340, height: 452 });
  await open(panel, "/home/menu-bar");
  // The panel's own fixed chrome-free layout still carries the health pill of the global bar.
  await panel.evaluate(() => {
    for (const e of Array.from(
      document.querySelectorAll<HTMLElement>("body *"),
    )) {
      const r = e.getBoundingClientRect();
      if (
        getComputedStyle(e).position === "fixed" &&
        r.width < 200 &&
        r.height < 60 &&
        r.y < 80
      )
        e.style.visibility = "hidden";
    }
  });
  await panel.mouse.move(2, 2);
  await shot(c, "menu-panel", undefined, panel);
  c.manifest.rects["menu-panel"] = { x: 0, y: 0, width: 340, height: 452 };
  await panel.close();
}

export async function icebergShots(c: Ctx): Promise<void> {
  const p = c.page;
  await open(p, "/website/foundations", { settleMs: 4000 });
  const prep = async (): Promise<number> =>
    p.evaluate(() => {
      const s = Array.from(document.querySelectorAll<HTMLElement>("*")).find(
        (e) =>
          e.scrollHeight > e.clientHeight + 50 &&
          /auto|scroll/.test(getComputedStyle(e).overflowY),
      );
      if (!s) throw new Error("iceberg: no scroller");
      for (const e of Array.from(
        document.querySelectorAll<HTMLElement>("body *"),
      )) {
        const pos = getComputedStyle(e).position;
        if ((pos === "fixed" || pos === "sticky") && !e.contains(s))
          e.style.visibility = "hidden";
      }
      s.setAttribute("data-promo", "scroller");
      s.scrollTop = 0;
      return s.scrollHeight;
    });
  const strip = async (name: string): Promise<number> => {
    const height = await prep();
    await p.waitForTimeout(600);
    const cards = await p.evaluate(() => {
      const s = document.querySelector<HTMLElement>('[data-promo="scroller"]')!;
      const top = s.getBoundingClientRect().top - s.scrollTop;
      return Array.from(s.querySelectorAll("button"))
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.height > 40 && r.width > 100)
        .map(({ e, r }) => ({
          label: (e.textContent ?? "").trim().slice(0, 60),
          x: r.x,
          y: r.y - top,
          width: r.width,
          height: r.height,
        }));
    });
    cards.forEach((card, i) => {
      c.manifest.stripRects[`${name}/card-${i}`] = card;
      if (/^Mac & Linux integration/.test(card.label))
        c.manifest.stripRects[`${name}/mac-linux`] = card;
    });
    if (!c.manifest.stripRects[`${name}/mac-linux`])
      throw new Error(
        `${name}: the "Mac & Linux integration" card was not found`,
      );
    const tiles: string[] = [];
    const tops: number[] = [];
    for (let y = 0; y < height; y += H) {
      const top = Math.min(y, height - H);
      await p.evaluate(
        (t) =>
          (document.querySelector<HTMLElement>(
            '[data-promo="scroller"]',
          )!.scrollTop = t),
        top,
      );
      await p.waitForTimeout(450);
      const n = `${name}-${String(tiles.length).padStart(2, "0")}`;
      await shot(c, n);
      tiles.push(n);
      tops.push(top);
    }
    c.manifest.strips[name] = { tiles, tops, height };
    return cards.length;
  };
  const collapsed = await strip("iceberg-collapsed");
  await open(p, "/website/foundations", { settleMs: 4000 });
  await p.getByRole("button", { name: /Expand all/ }).click();
  await p.waitForTimeout(2000);
  const expanded = await strip("iceberg");
  console.log(`  iceberg: ${collapsed} cards collapsed, ${expanded} expanded`);
}
