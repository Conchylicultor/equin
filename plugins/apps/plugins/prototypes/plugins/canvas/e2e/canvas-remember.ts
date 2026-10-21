// Verifies the canvas is remembered for its pane, within the browser tab: a
// fresh browser opens frame A alone; after adding the real app and a second
// prototype frame, picking a size preset and a zoom, a RELOAD brings the same
// canvas back — and the URL never changes (it names only the prototype).
// Closing a frame is remembered too, and so is a canvas opened in-app from the
// gallery. Opening the prototype anew (a navigation
// from the address bar, i.e. a new pane) starts fresh at frame A alone.
// Needs a prototype that declares a `mocks` counterpart this deploy resolves.
// Manual only — nothing runs this automatically.
//
// Usage:
//   ./singularity run plugins/apps/plugins/prototypes/plugins/canvas/e2e/canvas-remember.ts \
//     [--name <prototype id>] [--out <prefix>] [--headed]

import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  canvasFrameSelector,
  PROTOTYPE_FRAME_KIND,
} from "@plugins/apps/plugins/prototypes/plugins/canvas/core";
import {
  addSource,
  frameAction,
  listFrames,
  openCanvas,
  openSizeMenu,
  pickPrototype,
  pickSize,
  sizeChip,
  addFrame,
  setLayout,
} from "./driver";

const out = arg("out", "/tmp/canvas-remember");
const meta = await pickPrototype();
const bare = `/prototypes/proto/${meta.name}`;

await withBrowser(async (h) => {
  const r = report(`canvas remember — ${meta.title} (${meta.name})`);
  const { page, captured } = await h.session({
    viewport: { width: 1600, height: 1000 },
  });
  const kinds = async () =>
    (await listFrames(page)).map((f) => `${f.letter}:${f.kind}`).join(" ");
  const chip = async () =>
    (await sizeChip(page).innerText()).replace(/\s+/g, " ").trim();
  const pathname = () => new URL(page.url()).pathname;
  const reload = async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .locator(canvasFrameSelector({ letter: "A", status: "found" }))
      .waitFor({ state: "visible", timeout: 30_000 });
  };

  await openCanvas(page, meta.name);
  r.eq(
    "a fresh browser opens A alone",
    await kinds(),
    `A:${PROTOTYPE_FRAME_KIND}`,
  );
  // The size a fresh canvas opens at — the one the prototype declares.
  const freshChip = await chip();

  // Work the canvas: the real app, a copy of A, a preset, a fixed zoom.
  await addSource(page, "Real app");
  await addFrame(page);
  await pickSize(page, "Phone");
  await openSizeMenu(page);
  await page.getByRole("button", { name: "Actual size" }).click();
  await page.keyboard.press("Escape");
  const worked = await kinds();
  const workedChip = await chip();
  r.eq("the worked canvas", worked, "A:prototype B:real-app C:prototype");
  r.eq("…with the URL untouched", pathname(), bare);

  // Reload: the same canvas comes back.
  await reload();
  const back = await waitFor(kinds, (v) => v === worked, { timeoutMs: 20_000 });
  r.ok("a reload brings the frames back", back.ok, back.value);
  r.eq("…and the size and zoom", await chip(), workedChip);
  await page.mouse.move(2, 2);
  await snap(page, out, "reopened");

  // A closed frame stays closed.
  await frameAction(page, "C", "Remove from canvas");
  await reload();
  const closed = await waitFor(kinds, (v) => v === "A:prototype B:real-app", {
    timeoutMs: 20_000,
  });
  r.ok("a closed frame stays closed after a reload", closed.ok, closed.value);

  // Swiping, then adding a frame: the canvas goes side by side, and a reload
  // still brings every frame back.
  await setLayout(page, "swipe");
  await addFrame(page);
  const swiped = await kinds();
  r.eq(
    "a frame added while swiping",
    swiped,
    "A:prototype B:real-app C:prototype",
  );
  await reload();
  const swipedBack = await waitFor(kinds, (v) => v === swiped, {
    timeoutMs: 20_000,
  });
  r.ok("…is still there after a reload", swipedBack.ok, swipedBack.value);

  // A new pane (opened from the address bar) is a new comparison: fresh.
  await openCanvas(page, meta.name);
  r.eq(
    "opening the prototype anew starts at A alone",
    await kinds(),
    `A:${PROTOTYPE_FRAME_KIND}`,
  );
  r.eq("…at the size it declares", await chip(), freshChip);

  // Opened by an in-app navigation (the gallery card), not the address bar:
  // the tab set must save the route under the URL it now has, or a reload
  // gives the pane a new instance and the canvas is lost.
  await boot(page, pathUrl("/prototypes"), { settleMs: 500 });
  await page.getByText(meta.title, { exact: true }).first().click();
  await page
    .locator(canvasFrameSelector({ letter: "A", status: "found" }))
    .waitFor({ state: "visible", timeout: 30_000 });
  await addSource(page, "Real app");
  const opened = await kinds();
  r.eq(
    "opened from the gallery, with the real app",
    opened,
    "A:prototype B:real-app",
  );
  await reload();
  const openedBack = await waitFor(kinds, (v) => v === opened, {
    timeoutMs: 20_000,
  });
  r.ok("…is still there after a reload", openedBack.ok, openedBack.value);

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  await r.finish();
});
