/**
 * Manual-order drag in a list view slides instead of pointing.
 *
 * The flat views reorder through `rank-reorder`'s sortable provider: the row
 * itself follows the pointer (no floating chip) and the rows it passes slide out
 * of its way, and on drop it stays in its new slot — no frame where it jumps
 * back to where it started while the ranks catch up (data-view's pending-move
 * overlay). None of that is visible to a type-check, so it is asserted here on
 * the conversations sidebar Queue:
 *
 * - mid-drag: the dragged row carries a pure translate (scale 1) that tracks
 *   the pointer, a row it passed has a non-zero translateY, and the element
 *   under the pointer is the dragged row itself;
 * - after drop: sampled on every animation frame from the release on, the moved
 *   row is visually at its new index every time, and still there once the
 *   server's order has landed;
 * - then it drags the row back up, restoring the order it found.
 *
 * Needs a section with at least three draggable rows; refuses otherwise.
 *
 *   ./equin run plugins/primitives/plugins/data-view/plugins/list/e2e/sortable-reorder.ts [--out <prefix>] [--headed]
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";

const out = arg("out") ?? "/tmp/sortable-reorder";
const ROW = '[aria-roledescription="sortable"][data-row-key]';
/** Animation frames sampled after the release. */
const FRAMES = 30;

const r = report("data-view list — sortable manual-order drag");

/**
 * The keys of the first section holding at least three sortable rows, in
 * visual order. A row's section body is its nearest ancestor that holds more
 * than one sortable row (a windowed row sits alone in its own wrapper).
 */
async function sectionKeys(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const bodies = new Map<Element, HTMLElement[]>();
    for (const row of rows) {
      let body: Element | null = row.parentElement;
      while (body && body.querySelectorAll(selector).length < 2) {
        body = body.parentElement;
      }
      if (!body) continue;
      bodies.set(body, [...(bodies.get(body) ?? []), row]);
    }
    const section = [...bodies.values()].find((b) => b.length >= 3);
    if (!section) return [];
    return section
      .map((el) => ({
        key: el.dataset.rowKey!,
        y: el.getBoundingClientRect().top,
      }))
      .sort((a, b) => a.y - b.y)
      .map((e) => e.key);
  }, ROW);
}

const row = (page: Page, key: string) =>
  page.locator(`[data-row-key="${key}"]${ROW}`);

const centre = async (page: Page, key: string) => {
  const box = await row(page, key).boundingBox();
  if (!box) throw new Error(`row ${key} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** The row's computed transform, decomposed. */
const transformOf = (page: Page, key: string) =>
  row(page, key).evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { scaleX: m.a, scaleY: m.d, ty: m.f };
  });

/**
 * Start sampling, on every animation frame, the visual order of `keys` (sorted
 * by each row's live top edge). Returns immediately; read with `readSamples`.
 */
const startSampling = (page: Page, keys: string[]) =>
  page.evaluate(
    ({ keys, frames, selector }) => {
      const w = window as unknown as { __sortableSamples: string[][] };
      w.__sortableSamples = [];
      const tick = () => {
        const order = keys
          .map((key) => {
            const el = document.querySelector(
              `[data-row-key="${key}"]${selector}`,
            );
            return { key, y: el ? el.getBoundingClientRect().top : NaN };
          })
          .sort((a, b) => a.y - b.y)
          .map((e) => e.key);
        w.__sortableSamples.push(order);
        if (w.__sortableSamples.length < frames) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { keys, frames: FRAMES, selector: ROW },
  );

const readSamples = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __sortableSamples: string[][] })
        .__sortableSamples,
  );

/** Press on `from`'s centre and step past the 4px activation distance. */
async function pickUp(page: Page, key: string, direction: 1 | -1) {
  const start = await centre(page, key);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 10 * direction, { steps: 4 });
  return start;
}

await withBrowser(async (h) => {
  const { page } = await h.session();
  await boot(page, pathUrl("agents"), { settleMs: 3000 });
  await page
    .locator(ROW)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });

  const before = await sectionKeys(page);
  if (before.length < 3) {
    throw new Error(
      "sortable-reorder: needs a Queue section with at least 3 draggable rows (queued or pinned conversations); found none.",
    );
  }
  const [a, b, c] = before as [string, string, string];
  r.note(`section order: ${before.join(", ")}`);
  await snap(page, out, "before");

  // 1. Drag the first row down onto the third.
  const start = await pickUp(page, a, 1);
  const target = await centre(page, c);
  await page.mouse.move(start.x, target.y + 2, { steps: 12 });
  await page.waitForTimeout(400);
  await snap(page, out, "mid-drag");

  const dragged = await transformOf(page, a);
  r.eq("mid-drag: the dragged row is not scaled (x)", dragged.scaleX, 1);
  r.eq("mid-drag: the dragged row is not scaled (y)", dragged.scaleY, 1);
  const travelled = target.y + 2 - start.y;
  r.ok(
    `mid-drag: the dragged row follows the pointer (translateY ${dragged.ty.toFixed(1)} ≈ ${travelled.toFixed(1)})`,
    Math.abs(dragged.ty - travelled) < 4,
  );
  const passed = await transformOf(page, b);
  r.ok(
    `mid-drag: a row it passed slid out of the way (translateY ${passed.ty.toFixed(1)})`,
    passed.ty < -1,
  );
  const under = await page.evaluate(
    ({ x, y }) =>
      (
        document.elementFromPoint(x, y)?.closest("[data-row-key]") as
          HTMLElement | null | undefined
      )?.dataset.rowKey ?? null,
    { x: start.x, y: target.y + 2 },
  );
  r.eq("mid-drag: the row itself is under the pointer (no chip)", under, a);

  await startSampling(page, before);
  await page.mouse.up();
  // Headless Chromium throttles rAF, so a fixed wait can end after only a
  // handful of frames — wait for the sampler itself to finish.
  await page.waitForFunction(
    (frames) =>
      (window as unknown as { __sortableSamples: string[][] }).__sortableSamples
        .length >= frames,
    FRAMES,
    { timeout: 10_000 },
  );
  const samples = await readSamples(page);
  r.eq(`sampled ${FRAMES} frames after the drop`, samples.length, FRAMES);
  const expected = [b, c, a];
  const off = samples.findIndex(
    (order) => order.slice(0, 3).join() !== expected.join(),
  );
  r.ok(
    "after drop: the moved row is at its new index on every frame",
    off === -1,
    off === -1 ? undefined : `frame ${off}: ${samples[off]!.join(", ")}`,
  );
  await snap(page, out, "after-drop");

  // Past the optimistic window: the server's order is what renders now.
  await page.waitForTimeout(3000);
  const settled = await sectionKeys(page);
  r.eq(
    "after the push: the moved row is still at its new index",
    settled.slice(0, 3).join(),
    expected.join(),
  );
  await snap(page, out, "after-push");

  // 2. Put it back: drag it up onto the first row.
  const back = await pickUp(page, a, -1);
  const top = await centre(page, b);
  await page.mouse.move(back.x, top.y - 2, { steps: 12 });
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(3000);
  const restored = await sectionKeys(page);
  r.eq(
    "dragging it back up restores the order",
    restored.slice(0, 3).join(),
    before.slice(0, 3).join(),
  );
  await snap(page, out, "restored");
});

await r.finish();
