// Verifies a frame header at the tightest widths: the header row holds its
// shows box, a `Fill`, and the `⋯` — and the `Fill`'s own gap is room the
// adaptive bar must count. Sweeps the viewport so every frame's header passes
// through the band where the box only just fits, and checks after each step
// that a header with room for its box (box + a gap + `⋯`) still shows it in
// the row (narrowed, when the Fill's gap is all that is missing), and that no row overflows its box. Before the fix, a header inside
// that ~8px band tripped the bar's row-overflow guard and lost its box into the
// `⋯` until the frame was resized.
// Manual only — nothing runs this automatically.
//
// Usage:
//   ./equin run plugins/apps/plugins/prototypes/plugins/canvas/e2e/canvas-header-tight.ts \
//     [--name <prototype id>] [--from <px>] [--to <px>] [--out <prefix>] [--headed]

import {
  arg,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { addFrame, letters, openCanvas, pickPrototype } from "./driver";

const out = arg("out", "/tmp/canvas-header-tight");
const meta = await pickPrototype();

interface HeaderState {
  rowW: number;
  boxW: number | null;
  boxInRow: boolean;
  triggerW: number;
  gap: number;
  overflowPx: number;
  cells: string;
}

await withBrowser(async (h) => {
  const r = report(`canvas tight header — ${meta.title} (${meta.name})`);
  const { page, captured } = await h.session({
    viewport: { width: 1600, height: 900 },
  });
  await openCanvas(page, meta.name);
  for (let i = 0; i < 2; i++) await addFrame(page);
  const three = await waitFor(
    () => letters(page),
    (v) => v === "ABC",
    { timeoutMs: 10_000 },
  );
  r.ok("three frames on the canvas", three.ok, three.value);

  const read = (): Promise<HeaderState[]> =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-adaptive-bar-root]")]
        .filter(
          (root) =>
            root.querySelector("[data-adaptive-bar-anchor='shows']") !== null,
        )
        .map((root) => {
          const rect = root.getBoundingClientRect();
          const own = root.querySelector<HTMLElement>(
            ":scope > [data-adaptive-bar-item='shows']",
          );
          const trigger = root.querySelector<HTMLElement>(
            "[data-adaptive-bar-trigger]",
          );
          const items = [...root.children].filter(
            (c) => c.getClientRects().length > 0,
          );
          const right = Math.max(
            ...items.map((c) => c.getBoundingClientRect().right),
          );
          return {
            rowW: rect.width,
            boxW: own?.getBoundingClientRect().width ?? null,
            boxInRow: own !== null,
            triggerW: trigger?.getBoundingClientRect().width ?? 0,
            gap: Number.parseFloat(getComputedStyle(root).columnGap) || 0,
            overflowPx: Math.max(0, right - rect.right),
            cells: items
              .map(
                (c) =>
                  `${c.getAttribute("data-adaptive-bar-item") ?? c.className}:${c.getBoundingClientRect().width.toFixed(1)}`,
              )
              .join(" | "),
          };
        }),
    );

  // The box's full width, read while every header has room.
  const wide = await read();
  const boxW = Math.max(...wide.map((s) => s.boxW ?? 0));
  r.ok("headers found at full width", wide.length === 3, String(wide.length));

  let lost = 0;
  let overflowed = 0;
  let tight = 0;
  const from = Number(arg("from", "1600"));
  const to = Number(arg("to", "1000"));
  for (let width = from; width >= to; width -= 2) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(420);
    let states = await read();
    // A row mid-glide can overflow for a frame before its bar re-decides; only
    // an overflow still there once the geometry settled is a wrong decision.
    if (states.some((s) => s.overflowPx > 0.5)) {
      await page.waitForTimeout(1500);
      states = await read();
    }
    for (const s of states) {
      // The fit prices the box, ONE gap and the `⋯`; the row also holds the
      // `Fill`, whose gap is the second. In between is the band the fit got
      // wrong: it blessed the full box, the row overflowed, and the bar's
      // row-overflow guard floored it — box and all behind the `⋯`.
      const fitNeeds = boxW + s.gap + s.triggerW;
      if (s.rowW >= fitNeeds && s.rowW < fitNeeds + s.gap) tight += 1;
      if (s.rowW >= fitNeeds && !s.boxInRow) {
        lost += 1;
        console.log(
          `lost at viewport ${String(width)}: row ${s.rowW.toFixed(1)} ≥ ${fitNeeds.toFixed(1)}`,
        );
        if (lost === 1) await snap(page, out, `lost-${String(width)}`);
      }
      if (s.overflowPx > 0.5) {
        overflowed += 1;
        console.log(
          `overflow at viewport ${String(width)}: row ${s.rowW.toFixed(1)}, by ${s.overflowPx.toFixed(1)}px, box in row ${String(s.boxInRow)} (${String(s.boxW)}) — ${s.cells}`,
        );
      }
    }
  }
  r.ok("the sweep crossed the tight band", tight > 0, `${String(tight)} hits`);
  r.eq("no header with room lost its box into the ⋯", lost, 0);
  r.eq("no header row overflowed its box", overflowed, 0);
  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  await r.finish();
});
