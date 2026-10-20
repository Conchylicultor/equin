/**
 * Shared flows for the canvas e2e scripts: pick a prototype, open its canvas,
 * and read each frame back — its letter, kind, logical size, version and the
 * option values its document was opened with.
 *
 * Everything a frame is found by is the canvas's published DOM contract
 * (`canvasFrameSelector`, from `canvas/core`); everything a frame SHOWS is read
 * off the document the frame loaded (its iframe's `src` and `width`/`height`),
 * so an assertion is about what is on screen, never about app state.
 */

import type { Locator, Page } from "playwright";
import {
  agentFetch,
  arg,
  boot,
  pathUrl,
  usage,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type {
  ChoiceOption,
  PrototypeMeta,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  CANVAS_FRAME_ATTR,
  CANVAS_FRAME_KIND_ATTR,
  CANVAS_FRAME_STATUS_ATTR,
  CANVAS_LAYOUT_ATTR,
  canvasCardSelector,
  canvasFrameSelector,
  canvasLayoutSelector,
  type CanvasLayout,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/core";

/**
 * The prototype to drive: `--name`, else the first one that declares a
 * choice option with 3+ values and a `mocks` counterpart — what every canvas flow
 * needs (a variant to pick, a value to spread over, a real app to add).
 */
export async function pickPrototype(): Promise<PrototypeMeta> {
  const res = await agentFetch("/api/prototypes");
  if (!res.ok) throw new Error(`GET /api/prototypes → ${res.status}`);
  const rows = (await res.json()) as PrototypeMeta[];
  const wanted = arg("name");
  const meta = wanted
    ? rows.find((p) => p.name === wanted)
    : rows.find(
        (p) =>
          p.mocks.kind === "declared" &&
          p.options.some((o) => o.kind === "choice" && o.values.length >= 3),
      );
  if (!meta) {
    usage(
      wanted
        ? `no prototype "${wanted}" on this deploy (\`./singularity prototype list\`)`
        : "no prototype on this deploy declares both an option with 3+ values and a mocks counterpart — pass --name",
    );
  }
  return meta;
}

/** The first choice option with at least three values — the one flows pick and spread. */
export function spreadableOption(meta: PrototypeMeta): ChoiceOption {
  const option = meta.options.find(
    (o): o is ChoiceOption => o.kind === "choice" && o.values.length >= 3,
  );
  if (!option) usage(`${meta.name} declares no choice option with 3+ values`);
  return option;
}

/**
 * Open the canvas of `name`. It reopens as this browser last left it — a fresh
 * session's browser has left it nowhere, so that is frame A alone.
 */
export async function openCanvas(page: Page, name: string): Promise<void> {
  await boot(page, pathUrl(`/prototypes/proto/${name}`), {
    marker: canvasFrameSelector({ letter: "A", status: "found" }),
    settleMs: 500,
    describe: describeCanvas,
  });
}

/**
 * Where the canvas got to, for a timed-out open: a prototype frame is `found`
 * from its first render, so "no frame A" means the canvas never drew it (no
 * canvas root yet: the pane, the prototype list or the picks record was still
 * pending), while a canvas whose frames exist names each one's status.
 */
async function describeCanvas(page: Page): Promise<string> {
  if ((await page.locator(canvasLayoutSelector()).count()) === 0) {
    return "canvas: not drawn (no canvas root)";
  }
  const frames = await listFrames(page);
  return frames.length === 0
    ? "canvas: drawn, no frame yet (its room not measured)"
    : `canvas: ${frames.map((f) => `${f.letter} ${f.kind} ${f.status}`).join(", ")}`;
}

/**
 * Put a frame source's frame on the canvas through its header button
 * (`+ <addLabel>`). Its plugin loads in a later tier than the canvas, so the
 * button is waited for.
 */
export async function addSource(page: Page, addLabel: string): Promise<void> {
  const button = page.getByRole("button", { name: addLabel, exact: true });
  await button.waitFor({ state: "visible", timeout: 20_000 });
  await button.click();
}

/** One frame as the DOM publishes it. */
export interface FrameInfo {
  letter: string;
  kind: string;
  status: string;
}

/** Every frame on the canvas, in canvas order. */
export async function listFrames(page: Page): Promise<FrameInfo[]> {
  return page.locator(canvasFrameSelector()).evaluateAll(
    (els, attrs) =>
      els.map((el) => ({
        letter: el.getAttribute(attrs.letter) ?? "",
        kind: el.getAttribute(attrs.kind) ?? "",
        status: el.getAttribute(attrs.status) ?? "",
      })),
    {
      letter: CANVAS_FRAME_ATTR,
      kind: CANVAS_FRAME_KIND_ATTR,
      status: CANVAS_FRAME_STATUS_ATTR,
    },
  );
}

/** The letters on the canvas, joined: "ABC". */
export async function letters(page: Page): Promise<string> {
  return (await listFrames(page)).map((f) => f.letter).join("");
}

/** A frame's screen — the box the canvas publishes for it. */
export function screen(page: Page, letter: string): Locator {
  return page.locator(canvasFrameSelector({ letter }));
}

/**
 * A frame's whole card: header, screen and options pill. Side by side only —
 * a Swipe canvas draws no cards ({@link requireCards}).
 */
export function card(page: Page, letter: string): Locator {
  return page.locator(canvasCardSelector(letter));
}

/** The layout the canvas is drawing (Swipe only ever with two frames). */
export async function canvasLayout(page: Page): Promise<CanvasLayout> {
  const drawn = await page
    .locator(canvasLayoutSelector())
    .getAttribute(CANVAS_LAYOUT_ATTR);
  if (drawn !== "side" && drawn !== "swipe") {
    throw new Error(`canvas publishes ${CANVAS_LAYOUT_ATTR}="${drawn ?? ""}"`);
  }
  return drawn;
}

/**
 * Draw the canvas `side` by side or as a `swipe`, through the header's layout
 * control (shown only with exactly two frames). Adding a source frame swipes
 * it over frame A, so a flow that needs each frame on its own — its card, its
 * options pill, a screenshot of one screen — goes side by side first.
 */
export async function setLayout(
  page: Page,
  layout: CanvasLayout,
): Promise<void> {
  if ((await canvasLayout(page)) === layout) return;
  const label = layout === "side" ? "Side by side" : "Swipe";
  await page.getByRole("radio", { name: label, exact: true }).click();
  await page
    .locator(canvasLayoutSelector(layout))
    .waitFor({ state: "attached", timeout: 5000 });
}

/**
 * Fail at once, naming the cause, when the canvas is swiped: a swiped frame
 * has no card, so a card's control would otherwise just time out.
 */
async function requireCards(page: Page, letter: string): Promise<void> {
  if ((await canvasLayout(page)) === "side") return;
  throw new Error(
    `frame ${letter} has no card (header actions, options pill): the canvas is swiped — call setLayout(page, "side") first`,
  );
}

/** What a prototype frame's document was opened with. */
export interface FrameDoc {
  /** Logical size the page lays out at (the iframe's own box). */
  width: number;
  height: number;
  /** The recorded version's sha, or `null` for the live folder. */
  sha: string | null;
  /**
   * Every option's value the document was OPENED with — the pick in its `src`,
   * else the page's default. A color option moves without changing the `src`
   * (it is painted live): read what it shows with {@link frameColor}.
   */
  values: Record<string, string>;
}

/**
 * Read a prototype frame's document: the iframe on screen (not one still
 * loading on top of it, which is `aria-hidden`). `null` while it has none.
 */
export async function frameDoc(
  page: Page,
  meta: PrototypeMeta,
  letter: string,
): Promise<FrameDoc | null> {
  const iframe = screen(page, letter).locator("iframe:not([aria-hidden])");
  if ((await iframe.count()) !== 1) return null;
  const raw = await iframe.evaluate((el) => ({
    src: el.getAttribute("src") ?? "",
    width: Number(el.getAttribute("width")),
    height: Number(el.getAttribute("height")),
  }));
  const url = new URL(raw.src, "http://x");
  const sha = /\/versions\/([^/]+)\//.exec(url.pathname)?.[1] ?? null;
  const values: Record<string, string> = {};
  for (const o of meta.options) {
    values[o.name] = url.searchParams.get(o.name) ?? o.default;
  }
  return { width: raw.width, height: raw.height, sha, values };
}

/** A frame's value of one option, or `null` while its document is unknown. */
export async function frameValue(
  page: Page,
  meta: PrototypeMeta,
  letter: string,
  option: string,
): Promise<string | null> {
  return (await frameDoc(page, meta, letter))?.values[option] ?? null;
}

/**
 * The color a frame's document paints for a color option right now: the
 * computed `--<option>` on its `<html>`, lowercased — what the page's
 * `var(--<option>)` reads. `null` while the frame has no document.
 */
export async function frameColor(
  page: Page,
  letter: string,
  option: string,
): Promise<string | null> {
  const iframe = screen(page, letter).locator("iframe:not([aria-hidden])");
  if ((await iframe.count()) !== 1) return null;
  const handle = await iframe.elementHandle();
  const frame = handle ? await handle.contentFrame() : null;
  if (!frame) return null;
  return frame.evaluate(
    (name) =>
      getComputedStyle(document.documentElement)
        .getPropertyValue(`--${name}`)
        .trim()
        .toLowerCase(),
    option,
  );
}

/**
 * Reveal a frame's hover chrome (header actions, options pill) by
 * putting the pointer over its header row, which the page's own iframe never
 * covers.
 */
export async function hoverCard(page: Page, letter: string): Promise<void> {
  const box = await screen(page, letter).boundingBox();
  if (!box) throw new Error(`frame ${letter} has no box`);
  await page.mouse.move(box.x + box.width / 2, box.y - 20);
}

/** The `⋯` a header narrower than its actions folds the overflow into. */
const FRAME_ACTIONS_MORE = "Frame actions";

/**
 * Click one of a frame's header actions, by its label — in the header, or in
 * its `⋯` panel when the header is too narrow to show it.
 */
export async function frameAction(
  page: Page,
  letter: string,
  label: string | RegExp,
): Promise<void> {
  await requireCards(page, letter);
  await hoverCard(page, letter);
  const header = card(page, letter);
  const direct = header.getByRole("button", { name: label });
  if ((await direct.count()) > 0) return direct.click();
  const more = header.getByRole("button", { name: FRAME_ACTIONS_MORE });
  if ((await more.count()) === 0) {
    throw new Error(
      `frame ${letter} has no header action ${String(label)}, and no ${FRAME_ACTIONS_MORE} overflow`,
    );
  }
  await more.click();
  await page
    .getByRole("dialog", { name: FRAME_ACTIONS_MORE })
    .getByRole("button", { name: label })
    .click();
}

/** Open a frame's options popover and return it. */
export async function openOptions(
  page: Page,
  letter: string,
): Promise<Locator> {
  await requireCards(page, letter);
  await hoverCard(page, letter);
  await card(page, letter).getByLabel("Prototype options").click();
  const popover = page.getByRole("group", { name: "Options", exact: true });
  await popover.waitFor({ state: "visible", timeout: 5000 });
  return popover;
}

/**
 * One option's row in an options popover: its value chips, and its link and
 * spread buttons. The chips' radiogroup sits in the row's growing middle cell.
 */
export function optionRow(popover: Locator, label: string): Locator {
  return popover
    .getByRole("radiogroup", { name: label })
    .locator("xpath=../..");
}

/** Click one value chip of an option, in an open options popover. */
export async function pickValue(
  popover: Locator,
  label: string,
  valueLabel: string,
): Promise<void> {
  await popover
    .getByRole("radiogroup", { name: label })
    .getByRole("radio", { name: new RegExp(`^${valueLabel}`) })
    .click();
}

/** Close whatever popover is open. */
export async function dismiss(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.mouse.move(2, 2);
}

/** The canvas-wide size & zoom chip. */
export function sizeChip(page: Page): Locator {
  return page.getByRole("button", { name: "Size and zoom" });
}

/** Open the size & zoom menu. */
export async function openSizeMenu(page: Page): Promise<void> {
  await sizeChip(page).click();
  await page
    .getByRole("switch", { name: /Whole page/ })
    .waitFor({ state: "visible", timeout: 5000 });
}

/** Pick a size row (`Responsive`, a preset name) in the size & zoom menu. */
export async function pickSize(page: Page, name: string): Promise<void> {
  await openSizeMenu(page);
  await page.getByRole("radio", { name: new RegExp(`^${name}`) }).click();
  await dismiss(page);
}
