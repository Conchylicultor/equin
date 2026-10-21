// Verifies a frame's header on a crowded canvas: with four frames side by side
// each header is as narrow as its screen, and its actions that do not fit move
// behind a `⋯` ("Frame actions") instead of being clipped off the row. The
// relocated actions are visible and work in the panel — the hover reveal hides
// an action only while it sits in the row. With one frame there is room: no
// `⋯`, and the actions are in the row.
// Manual only — nothing runs this automatically.
//
// Usage:
//   ./singularity run plugins/apps/plugins/prototypes/plugins/canvas/e2e/canvas-narrow-header.ts \
//     [--name <prototype id>] [--out <prefix>] [--headed]

import {
  arg,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  card,
  hoverCard,
  letters,
  openCanvas,
  pickPrototype,
  addFrame,
} from "./driver";

const out = arg("out", "/tmp/canvas-narrow-header");
const meta = await pickPrototype();
const MORE = "Frame actions";

await withBrowser(async (h) => {
  const r = report(`canvas narrow header — ${meta.title} (${meta.name})`);
  const { page, captured } = await h.session({
    viewport: { width: 1280, height: 900 },
  });
  await openCanvas(page, meta.name);
  const waitLetters = (want: string) =>
    waitFor(
      () => letters(page),
      (v) => v === want,
      { timeoutMs: 10_000 },
    );

  // One frame: the header has room — no `⋯`.
  r.eq(
    "one frame: no ⋯ in its header",
    await card(page, "A").getByRole("button", { name: MORE }).count(),
    0,
  );

  // Four frames: each header is a quarter of the canvas.
  for (let i = 0; i < 3; i++) await addFrame(page);
  const four = await waitLetters("ABCD");
  r.ok("four frames on the canvas", four.ok, four.value);
  await page.waitForTimeout(500);
  await snap(page, out, "four");
  for (const letter of "ABCD") {
    r.eq(
      `frame ${letter}'s header shows its version`,
      await card(page, letter)
        .getByRole("group", { name: "Version" })
        .isVisible(),
      true,
    );
  }

  const trigger = card(page, "D").getByRole("button", { name: MORE });
  await waitFor(
    () => trigger.count(),
    (n) => n === 1,
    { timeoutMs: 5000 },
  );
  r.eq("four frames: D's header has a ⋯", await trigger.count(), 1);

  await hoverCard(page, "D");
  await trigger.click();
  const panel = page.getByRole("dialog", { name: MORE });
  await panel.waitFor({ state: "visible", timeout: 5000 });
  await snap(page, out, "panel");
  const close = panel.getByRole("button", { name: /Remove from canvas/ });
  r.eq("Close is in the ⋯ panel", await close.count(), 1);
  // The panel is portaled out of the frame, so a hover reveal that also hid
  // the action there would show as a zero opacity somewhere up its chain.
  const opacity = await close.evaluate((el) => {
    let node: Element | null = el;
    let o = 1;
    while (node) {
      o *= Number(getComputedStyle(node).opacity);
      node = node.parentElement;
    }
    return o;
  });
  r.eq("Close is visible in the panel", opacity, 1);

  await close.click();
  const three = await waitLetters("ABC");
  r.ok("Close in the panel removes frame D", three.ok, three.value);

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  await r.finish();
});
