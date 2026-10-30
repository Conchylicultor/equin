// Shots 3-5: Deploy, and Places as the session's home — the Wish bar, the
// element picker, the "opening hours" prompt typed, the injected "after", and
// the Wish popover asking for a P2P messaging app.

import type { Page } from "playwright";
import {
  type Ctx,
  W,
  H,
  byText,
  domClick,
  hideBar,
  hideBarStatus,
  measure,
  open,
  park,
  rect,
  shot,
  sweepNoise,
  typeSequence,
} from "./capture-kit";

export const HOURS_PROMPT = "Show opening hours under each place";
export const CREATE_PROMPT = "Create a P2P messaging app";

/** The user's real server address is not the film's: a documentation-range stand-in, applied to every text node. */
async function redactAddress(p: Page): Promise<void> {
  await p.evaluate(() => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode())
      n.nodeValue = (n.nodeValue ?? "").replace(
        /\d+\.\d+\.\d+\.\d+/g,
        "203.0.113.42",
      );
    for (const i of Array.from(document.querySelectorAll("input"))) {
      i.value = i.value
        .replace(/\d+\.\d+\.\d+\.\d+/g, "203.0.113.42")
        .replace(/projects\/\d+\/servers\/\d+/, "projects/1/servers/1");
    }
  });
}

export async function deployShot(c: Ctx): Promise<void> {
  const p = c.page;
  await open(p, "/deploy");
  await redactAddress(p);
  await hideBar(p);
  await park(p);
  await shot(c, "deploy-servers");
  // The server, its Deployments section open, and the deployment's own pane with its run history.
  await p
    .getByText(/^203\.0\.113\.42$/)
    .first()
    .click();
  await p.waitForTimeout(3000);
  await p.getByText("Deployments", { exact: true }).last().click();
  await p.waitForTimeout(2000);
  await p.getByText("website", { exact: true }).first().click();
  await p
    .getByText("History", { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await p.getByText("History", { exact: true }).first().click();
  await p.waitForTimeout(2500);
  await p.getByText("Overview", { exact: true }).first().click();
  await p.waitForTimeout(2500);
  await p.mouse.move(400, 300);
  await p.mouse.wheel(0, -6000);
  await p.waitForTimeout(1200);
  await redactAddress(p);
  await hideBar(p);
  await park(p);
  await shot(c, "deploy");
  await rect(c, "deploy-servers-pane", () => {
    let n: Element | null =
      Array.from(document.querySelectorAll("*")).find(
        (e) => e.children.length === 0 && e.textContent === "Servers",
      ) ?? null;
    while (n && n.getBoundingClientRect().width < 250) n = n.parentElement;
    return n;
  });
  await rect(c, "deploy-detail", () => {
    let n: Element | null =
      Array.from(document.querySelectorAll("*")).find((e) =>
        Array.from(e.childNodes).some(
          (x) => x.nodeType === 3 && x.nodeValue === "Composition",
        ),
      ) ?? null;
    while (n && n.getBoundingClientRect().width < 500) n = n.parentElement;
    return n;
  });
}

const places = (p: Page) => open(p, "/places", { settleMs: 7000 });

/** Every card of the places list, as the row buttons. */
async function cardRects(c: Ctx, prefix: string, count: number): Promise<void> {
  const rs = await c.page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('button[data-row-key^="place-"]'),
    )
      .map((b) => {
        const r = b.getBoundingClientRect();
        return {
          name:
            b.querySelector("[class*=text-label]")?.textContent?.trim() ?? "",
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        };
      })
      .filter((r) => r.y > 60 && r.y + r.height < 720)
      .sort((a, b) => a.y - b.y),
  );
  if (rs.length < count)
    throw new Error(`places: only ${rs.length} cards visible`);
  rs.slice(0, count).forEach(
    (r, i) =>
      (c.manifest.rects[`${prefix}-card-${i}`] = {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      }),
  );
}

const card = (name: string) =>
  byText(name, { minH: 44, minW: 300 }, { minX: 900 });

export async function placesShots(c: Ctx): Promise<void> {
  const p = c.page;
  await places(p);
  await hideBar(p);
  await park(p);
  await shot(c, "places");
  await rect(
    c,
    "places-sidebar",
    () => document.querySelector("[data-pane-id], aside") ?? null,
  );
  await rect(
    c,
    "places-search",
    () =>
      (
        document.querySelector(
          'input[placeholder*="Search or add places"]',
        ) as Element | null
      )?.closest("div") ?? null,
  );
  await rect(
    c,
    "places-list",
    () =>
      Array.from(document.querySelectorAll('button[data-row-key^="place-"]'))[0]
        ?.parentElement?.parentElement?.parentElement ?? null,
  );
  await rect(
    c,
    "places-map",
    () => document.querySelector(".gm-style") ?? null,
  );
  await cardRects(c, "places", 8);
  await rect(c, "places-card-picked", card("Les Disquaires"));

  // The bar, expanded: Wish and the Pick UI element segment.
  await hideBar(p, false);
  await p.mouse.move(W - 40, 28, { steps: 4 });
  await p.waitForTimeout(900);
  await hideBarStatus(p);
  await rect(c, "bar", () => document.querySelector("[data-film-bar]"));
  await rect(
    c,
    "wish-button",
    () =>
      Array.from(document.querySelectorAll("button")).find(
        (b) =>
          b.getAttribute("aria-label") === "Wish" ||
          (b.textContent ?? "").trim() === "Wish",
      ) ?? null,
  );
  await rect(
    c,
    "pick-button",
    () =>
      Array.from(document.querySelectorAll("button")).find(
        (b) => b.getAttribute("aria-label") === "Pick UI element",
      ) ?? null,
  );
  await shot(c, "places-bar");

  // The element picker: the hover outline on four different elements.
  await domClick(p, "Pick UI element");
  await p.waitForTimeout(500);
  await hideBar(p);
  const targets: Array<[string, () => Element | null]> = [
    [
      "search",
      () =>
        document.querySelector('input[placeholder*="Search or add places"]'),
    ],
    [
      "preset",
      () =>
        Array.from(document.querySelectorAll("*")).find(
          (e) => e.children.length === 0 && e.textContent === "Restaurants",
        ) ?? null,
    ],
    [
      "tag",
      () =>
        Array.from(document.querySelectorAll("*")).find(
          (e) => e.children.length === 0 && e.textContent === "Museum",
        ) ?? null,
    ],
    [
      "card",
      () =>
        Array.from(document.querySelectorAll("*")).find(
          (e) => e.children.length === 0 && e.textContent === "Le Jardin Paris",
        ) ?? null,
    ],
    [
      "picked",
      () =>
        Array.from(document.querySelectorAll("*")).find(
          (e) =>
            e.children.length === 0 &&
            e.textContent === "Les Disquaires" &&
            e.getBoundingClientRect().x > 900,
        ) ?? null,
    ],
  ];
  for (const [name, f] of targets) {
    const r = await rect(c, `pick-${name}-target`, f);
    await p.mouse.move(r.x + r.width * 0.4, r.y + r.height / 2, { steps: 6 });
    await p.waitForTimeout(450);
    await shot(c, `pick-${name}`);
  }
  // Click the last (Les Disquaires): the popover opens with the element chip.
  const t = c.manifest.rects["pick-picked-target"]!;
  await p.mouse.click(t.x + t.width * 0.4, t.y + t.height / 2);
  await p.waitForTimeout(1200);
  await hideBar(p);
  await park(p, 400, H - 3);
  await rect(c, "places-picked-chip", () => {
    const e = Array.from(document.querySelectorAll("*")).find((x) => {
      if (x.children.length !== 0 || x.textContent !== "Les Disquaires")
        return false;
      const r = x.getBoundingClientRect();
      return r.y > 90 && r.y < 170 && r.x > 680;
    });
    return e?.closest("[class*=rounded]") ?? e ?? null;
  });
  await shot(c, "places-picked");
  await typeSequence(c, "places-wish", HOURS_PROMPT, true);
  await domClick(p, "Cancel");
  await p.waitForTimeout(700);

  // The agent's change, staged: an opening-hours line under the address of every card, native styling.
  await hideBar(p);
  await p.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('button[data-row-key^="place-"]'),
    );
    if (rows.length < 6) throw new Error("places: no cards to stage hours on");
    const hours = [
      "Open today · 10:00 – 23:00",
      "Open today · 12:00 – 02:00",
      "Open today · 09:00 – 18:30",
      "Open today · 17:00 – 01:00",
      "Open today · 11:30 – 22:00",
    ];
    const wrappers = rows
      .map((b) => ({ b, w: b.parentElement!.parentElement as HTMLElement }))
      .sort(
        (a, b) =>
          parseFloat(a.w.style.translate.split(" ")[1] ?? "0") -
          parseFloat(b.w.style.translate.split(" ")[1] ?? "0"),
      );
    wrappers.forEach(({ b, w }, i) => {
      const col = b.querySelector(":scope > div.flex-col");
      const addr = col?.children[1];
      if (!col || !addr) throw new Error("places: card has no address line");
      const leaf = Array.from(addr.querySelectorAll<HTMLElement>("*")).find(
        (e) => e.children.length === 0 && (e.textContent ?? "").trim(),
      );
      if (!leaf) throw new Error("places: address line has no text");
      const cl = document.createElement("div");
      cl.className = addr.className;
      cl.setAttribute("data-film", "hours");
      const txt = leaf.cloneNode(false) as HTMLElement;
      txt.textContent = hours[i % hours.length]!;
      txt.style.color = "oklch(0.52 0.14 150)";
      txt.style.fontWeight = "550";
      cl.appendChild(txt);
      col.appendChild(cl);
      w.style.translate = `0px ${i * 62}px`;
      w.style.height = "auto";
      (w.firstElementChild as HTMLElement).style.height = "auto";
    });
  });
  await p.waitForTimeout(500);
  await park(p);
  await shot(c, "places-after");
  await cardRects(c, "places-after", 6);
  await rect(c, "places-after-hours-0", '[data-film="hours"]');
}

export async function createShots(c: Ctx): Promise<void> {
  const p = c.page;
  await places(p);
  await hideBar(p, false);
  await p.mouse.move(W - 40, 28, { steps: 4 });
  await p.waitForTimeout(900);
  await domClick(p, "Wish");
  await p.waitForTimeout(900);
  await hideBar(p);
  await park(p, 400, H - 3);
  await shot(c, "create-popover");
  await typeSequence(c, "create-wish", CREATE_PROMPT, false, 9);
  await domClick(p, "Cancel");
  void measure;
  void sweepNoise;
}
