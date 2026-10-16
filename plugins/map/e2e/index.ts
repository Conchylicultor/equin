// Driving a map's pins from an e2e script. Pins at rest are pixels on the
// pin canvas, not elements: the map lists the pins on screen in a hidden
// list (`[data-map-pins]`, rebuilt each time the camera comes to rest) — each
// a button named like the pin, carrying where the pointer finds it (`data-x`
// / `data-y`, px from the map's top-left) and whether another pin is stacked
// over that point (`data-reachable`). A pin under the pointer is lifted into
// the DOM as a real button, which is what a click lands on.

import type { Locator, Page } from "playwright";

export {
  startZoomProbe,
  stopZoomProbe,
  zoomProbeLines,
  zoomProbeSource,
} from "./zoom-probe";
export type { ProbeGesture, ProbeLoaf, ZoomProbeSummary } from "./zoom-probe";

/** One pin on screen: its accessible name and where the pointer finds it (viewport px). */
export interface PinOnScreen {
  label: string;
  x: number;
  y: number;
  /** No other pin is stacked over that point: hovering it lifts THIS pin. */
  reachable: boolean;
}

/** The hidden list's entries — one per pin (or cluster) drawn on screen. */
export function listedPins(page: Page): Locator {
  return page.locator("[data-map-pins] button[aria-label]");
}

/**
 * Every pin drawn on screen at the last camera rest, with its point in
 * viewport px. Waits for at least one when `atLeastOne` (the default).
 */
export async function pinsOnScreen(
  page: Page,
  { atLeastOne = true }: { atLeastOne?: boolean } = {},
): Promise<PinOnScreen[]> {
  if (atLeastOne)
    await listedPins(page)
      .first()
      .waitFor({ state: "attached", timeout: 120_000 });
  return page.evaluate(() => {
    const list = document.querySelector("[data-map-pins]");
    if (list === null) throw new Error("no [data-map-pins] list on the page");
    // The points are measured from the map's own element, which Google's
    // `.gm-style` root fills.
    const surface = document.querySelector(".gm-style");
    if (surface === null) throw new Error("no .gm-style map on the page");
    const map = surface.getBoundingClientRect();
    return [...list.querySelectorAll("button[aria-label]")].map((b) => ({
      label: b.getAttribute("aria-label") ?? "",
      x: map.left + Number(b.getAttribute("data-x")),
      y: map.top + Number(b.getAttribute("data-y")),
      reachable: b.getAttribute("data-reachable") === "true",
    }));
  });
}

/** The lifted (DOM) pin named `label` — present while it is hovered or active. */
export function liftedPin(page: Page, label: string): Locator {
  return page
    .locator(`.gm-style [role="button"][aria-label="${label}"]`)
    .first();
}

/**
 * The pins a pointer can reach — none stacked over them — that are pins, not
 * clusters: what a script picks to hover or click.
 */
export async function reachablePins(page: Page): Promise<PinOnScreen[]> {
  return (await pinsOnScreen(page)).filter(
    (p) => p.reachable && !p.label.endsWith("zoom in"),
  );
}

/**
 * Hover the pin named `label` (the first reachable one with that name) so the
 * map lifts it, and return the lifted button. Throws for a pin another one is
 * stacked over — zoom in first.
 */
export async function hoverPin(page: Page, label: string): Promise<Locator> {
  const named = (await pinsOnScreen(page)).filter((p) => p.label === label);
  if (named.length === 0) throw new Error(`no pin "${label}" on screen`);
  const pin = named.find((p) => p.reachable);
  if (pin === undefined) {
    throw new Error(`pin "${label}" is under another pin here — zoom in first`);
  }
  await page.mouse.move(pin.x, pin.y, { steps: 2 });
  const lifted = liftedPin(page, label);
  await lifted.waitFor({ timeout: 10_000 });
  return lifted;
}

/** Click the pin named `label` the way a user does: hover it, then click the lifted pin. */
export async function clickPin(page: Page, label: string): Promise<void> {
  const lifted = await hoverPin(page, label);
  await lifted.click();
}
