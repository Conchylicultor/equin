// Records, frame by frame on the film's virtual clock (media/film's recorder),
// the two moments a prototype comes into view, and logs per frame where the
// moving parts are drawn:
//
//   pane — a `proto-…` chip in a conversation clicked: the prototype column
//          enters beside it (its content sliding in while it fades, the
//          conversation narrowing underneath) — never a one-frame pop-in.
//   add  — `+` on the canvas: the new frame eases in where it lands while the
//          frames already there glide to their new boxes.
//
// Each frame logs every miller column (pane id, x/width, its content's
// opacity) or every canvas card (letter, x/width, opacity), so a jump shows
// as one frame going from the old values to the new; the JPEGs land in --out.
// Manual only.
//
// Usage:
//   ./equin run plugins/apps/plugins/prototypes/plugins/canvas/e2e/canvas-motion-frames.ts \
//     --conv <conversation holding a proto- id> [--name <prototype id>] \
//     --out <dir> [--frames 30] [--headed]

import {
  numArg,
  pathUrl,
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  installRecorderClock,
  record,
  type Recorder,
} from "@plugins/media/plugins/film/e2e";
import type { Page } from "playwright";
import { openCanvas, pickPrototype } from "./driver";

const USAGE =
  "usage: canvas-motion-frames.ts --conv <conversationId> --out <dir>";
const CONV = requireArg("conv", USAGE);
const OUT = requireArg("out", USAGE);
const FRAMES = numArg("frames", 30);
const meta = await pickPrototype();

/** Where the columns are drawn, one string per column. */
function columns(page: Page): Promise<string> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-miller-column]")]
      .map((c) => {
        const r = c.getBoundingClientRect();
        const box = c.querySelector<HTMLElement>("[data-pane-id]");
        const content = box
          ? [...box.children]
              .map((k) => Number(getComputedStyle(k).opacity).toFixed(2))
              .join(",")
          : "-";
        return `${box?.dataset.paneId ?? "?"} ${String(Math.round(r.x))}/${String(Math.round(r.width))} [${content}]`;
      })
      .join(" | "),
  );
}

/** Where the canvas's cards are drawn, one string per card. */
function cards(page: Page): Promise<string> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-canvas-card]")]
      .map((c) => {
        const r = c.getBoundingClientRect();
        return `${c.dataset.canvasCard ?? "?"} ${String(Math.round(r.x))}/${String(Math.round(r.width))} o${Number(getComputedStyle(c).opacity).toFixed(2)}`;
      })
      .join(" | "),
  );
}

/** One frame at a time, logging `probe` after each. */
async function frames(
  r: Recorder,
  probe: () => Promise<string>,
  log: string[],
): Promise<void> {
  for (let i = 0; i < FRAMES; i++) {
    await r.hold(1 / 60);
    log.push(`${String(i).padStart(3)} ${await probe()}`);
  }
}

await withBrowser(async (h) => {
  const rep = report(`prototype motion frames — ${meta.title}`);
  const session = async (): Promise<Page> => {
    const { page, context } = await h.session({
      viewport: { width: 1280, height: 720 },
      colorScheme: "dark",
      capture: false,
    });
    await installRecorderClock(context);
    return page;
  };

  const pane = await session();
  await pane.goto(pathUrl(`/agents/c/${CONV}`));
  const chip = pane.locator('button[data-tooltip*="proto-"]').first();
  await chip.waitFor({ timeout: 20_000 });
  await chip.scrollIntoViewIfNeeded();
  await pane.waitForTimeout(1500);
  const paneLog: string[] = [];
  await record(pane, { dir: OUT, name: "pane" }, async (r) => {
    paneLog.push(`  - ${await columns(pane)}`);
    await r.click(chip, { duration: 0.2 });
    await frames(r, () => columns(pane), paneLog);
  });
  rep.note(`pane (frames in ${OUT}/pane-*.jpg):\n${paneLog.join("\n")}`);

  const add = await session();
  await openCanvas(add, meta.name);
  await add.waitForTimeout(1500);
  const addLog: string[] = [];
  await record(add, { dir: OUT, name: "add" }, async (r) => {
    addLog.push(`  - ${await cards(add)}`);
    const button = add.locator('button[aria-label="Add a frame to compare"]');
    await r.move(add.locator("[data-canvas-card]").last(), { duration: 0.2 });
    await r.click(button.first(), { duration: 0.2 });
    await frames(r, () => cards(add), addLog);
  });
  rep.note(`add (frames in ${OUT}/add-*.jpg):\n${addLog.join("\n")}`);
});
