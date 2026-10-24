/**
 * The behavioural proof: a draggable widget relocates into the overflow panel,
 * is STILL DRAGGABLE there, and comes back as the same instance.
 *
 * Nothing else can establish this. The pure suite proves the fit math, the
 * jsdom suite proves React never unmounted the subtree, and the geometry gate
 * proves the boxes do not collide — but "the slider still responds to a real
 * pointer drag after being re-parented across the document" is a question only
 * a real browser answers.
 *
 * It drives the `adaptive-bar/rich-widgets` exhibit in the live Exhibits gallery
 * (Debug → Exhibits). The gallery renders that fixture once per swept width,
 * so the script takes ONE card and resizes it: five side-by-side widths would
 * be five different instances, and the whole claim is about one.
 *
 * Manual only — nothing runs this automatically.
 *
 *   ./equin build
 *   ./equin run plugins/primitives/plugins/adaptive-bar/e2e/adaptive-bar-relocate.ts [--headed]
 */
import {
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/adaptive-bar-relocate";
const FIXTURE = '[data-testid="adaptive-bar-rich"]';
const WHEEL = `${FIXTURE} [role="slider"]`;

await withBrowser(async (h) => {
  const { page, captured } = await h.session();
  const r = report("adaptive-bar — relocate & keep dragging");

  await page.goto(pathUrl("/debug/exhibits"));
  await page.waitForSelector(FIXTURE, { timeout: 20_000 });
  await page.waitForTimeout(500);

  const fixture = page.locator(FIXTURE).first();
  const wheel = fixture.locator('[role="slider"]');

  /**
   * The width box the gallery wraps each fixture card in. Resizing it is the
   * closest thing to a user dragging a pane divider that the gallery offers, and it
   * drives the bar's own ResizeObserver exactly as a real resize would.
   */
  async function setCardWidth(px: number): Promise<void> {
    await fixture.evaluate((el, width) => {
      // Walk out to the gallery's fixed-width card — the nearest ancestor the
      // gallery gave an inline width.
      let node: HTMLElement | null = el.parentElement;
      while (node !== null && node.style.width === "")
        node = node.parentElement;
      if (node === null)
        throw new Error("no fixed-width gallery card above the fixture");
      node.style.width = `${String(width)}px`;
    }, px);
    await page.waitForTimeout(400);
  }

  /** Is the jog wheel still in the bar's row, or has it relocated into the panel? */
  async function wheelIsInline(): Promise<boolean> {
    return page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el !== null && el.closest('[role="dialog"]') === null;
    }, WHEEL);
  }

  // ── 1. Wide: everything inline, and we learn the instance's identity ──────
  await setCardWidth(760);
  const startId = await wheel.getAttribute("data-instance-id");
  const startValue = await wheel.getAttribute("aria-valuenow");
  r.ok("wheel starts inline", await wheelIsInline());
  r.ok(
    "wheel minted an instance id",
    startId !== null,
    `got ${String(startId)}`,
  );
  r.note(`instance=${String(startId)} value=${String(startValue)}`);
  await snap(page, OUT, "1-wide");

  // The regression test for the entire premise. Today's MeasureStrip mechanism
  // would make this 2 — one live copy and one hidden copy rendered purely to be
  // measured. It must be 1 at EVERY width.
  async function countInstances(tag: string): Promise<void> {
    const n = await page
      .locator(`[data-instance-id="${String(startId)}"]`)
      .count();
    r.eq(`exactly one instance at ${tag}`, n, 1);
  }
  await countInstances("760px");

  // ── 2. Narrow until it relocates ─────────────────────────────────────────
  await setCardWidth(240);
  r.ok("wheel relocated into the panel", !(await wheelIsInline()));
  await countInstances("240px");
  r.eq(
    "the same instance is in the panel",
    await wheel.getAttribute("data-instance-id"),
    startId,
  );

  // ── 3. Open the panel and DRAG the relocated slider ──────────────────────
  await fixture.locator("[data-adaptive-bar-trigger] button").click();
  await page.waitForTimeout(300);
  await snap(page, OUT, "2-panel-open");

  const box = await wheel.boundingBox();
  if (box === null) {
    r.fail(
      "the relocated slider has no box",
      "it is not laid out inside the panel",
    );
  } else {
    // A real pointer drag across the slider face, not a synthetic value write.
    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const dragged = await wheel.getAttribute("aria-valuenow");
    r.ok(
      "the relocated slider still drags",
      dragged !== startValue,
      `aria-valuenow stayed at ${String(dragged)}`,
    );
    const readout = await fixture
      .locator('[data-testid="jog-readout"]')
      .textContent();
    r.eq("its readout followed the drag", readout?.trim(), dragged);
    r.note(`value ${String(startValue)} → ${String(dragged)}`);
  }
  await snap(page, OUT, "3-after-drag");

  const draggedValue = await wheel.getAttribute("aria-valuenow");

  // ── 4. Widen: back inline, same instance, and the drag came with it ───────
  await setCardWidth(760);
  r.ok("wheel is back inline", await wheelIsInline());
  r.eq(
    "still the same instance",
    await wheel.getAttribute("data-instance-id"),
    startId,
  );
  // The single-instance claim's real payload: a second instance would have
  // started at the initial value, because that is what its own useState says.
  r.eq(
    "its dragged value survived the round trip",
    await wheel.getAttribute("aria-valuenow"),
    draggedValue,
  );
  await countInstances("760px again");
  await snap(page, OUT, "4-wide-again");

  // ── 5. The trigger never escapes the row it belongs to ───────────────────
  for (const width of [760, 560, 420, 300, 220]) {
    await setCardWidth(width);
    const inside = await fixture.evaluate((el) => {
      const trigger = el.querySelector("[data-adaptive-bar-trigger]");
      if (trigger === null || (trigger as HTMLElement).hidden) return true;
      const bar = trigger.parentElement;
      if (bar === null) return false;
      const t = trigger.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      return t.left >= b.left - 0.5 && t.right <= b.right + 0.5;
    });
    r.ok(`trigger stays inside the bar at ${String(width)}px`, inside);
    await countInstances(`${String(width)}px sweep`);
  }

  // A dev build throws on either placement guard, so a page error here is very
  // likely the bar telling us the fixture's layout broke its own contract.
  if (captured.pageErrors.length > 0) {
    r.fail("page errors", captured.pageErrors.join(" | "));
  }
  await r.finish();
});
