// Verifies a prototype frame's two frame actions. Full screen takes frame A
// over the whole screen with its chrome (the tag with its version stepper, the
// options pill, the size chip), ← / → flip to the other frame in place,
// leaving full screen brings it back, and `F` presents the selected
// frame; Open in a new tab opens the chromeless present page at the
// Responsive size, filling the tab. Manual only — nothing runs this
// automatically.
//
// Usage:
//   ./singularity run plugins/apps/plugins/prototypes/plugins/present/e2e/present-verify.ts \
//     [--name <prototype>] [--out <prefix>] [--headed]

import type { Page } from "playwright";
import {
  agentFetch,
  arg,
  boot,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  humanizeToken,
  type ChoiceOption,
  type PrototypeMeta,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { canvasFrameSelector } from "@plugins/apps/plugins/prototypes/plugins/canvas/core";

const out = arg("out", "/tmp/present-verify");

/**
 * The prototype to present: the named one, else the first that declares options
 * (a theme, a palette) — those are what the picker assertions need. Falls back
 * to the first prototype at all, and the picker assertions then skip.
 */
async function target(): Promise<PrototypeMeta> {
  const res = await agentFetch(`/api/prototypes`);
  if (!res.ok) throw new Error(`GET /api/prototypes → ${res.status}`);
  const rows = (await res.json()) as PrototypeMeta[];
  const wanted = arg("name");
  const meta = wanted
    ? rows.find((p) => p.name === wanted)
    : (rows.find((p) => p.options.length > 0) ?? rows[0]);
  if (!meta)
    throw new Error(
      wanted ? `no prototype ${wanted}` : "no prototypes exist to present",
    );
  return meta;
}

const meta = await target();
const name = meta.name;
// The choice option a chip will switch while fullscreen (a choice reloads the
// frame, which is what the check watches), and a value that is not the one
// already on screen. Absent when the prototype declares no choice option.
const option = meta.options.find(
  (o): o is ChoiceOption =>
    o.kind === "choice" && o.values.some((v) => v !== o.default),
);
const otherValue = option?.values.find((v) => v !== option.default);

/** The live prototype document's frame URL, wherever it is mounted. */
function frameUrl(page: Page): string | undefined {
  return page
    .frames()
    .find((f) => f.url().includes(`/api/prototypes/${name}/index.html`))
    ?.url();
}

await withBrowser(async (h) => {
  const r = report(`present — ${name}`);
  const { page, context, captured } = await h.session({
    viewport: { width: 1440, height: 900 },
  });
  await boot(page, pathUrl(`/prototypes/proto/${name}`), {
    marker: canvasFrameSelector({ letter: "A", status: "found" }),
    settleMs: 1000,
  });

  const frameA = page.locator(canvasFrameSelector({ letter: "A" }));
  const dialog = page.getByRole("dialog", { name: "Prototype presentation" });
  const viewport = page.viewportSize();

  /** Frame A's own Full screen: hover its screen, click its button. */
  async function fullScreenA() {
    await frameA.hover();
    // Frame A's header comes first, so its button is the first one.
    await page
      .getByRole("button", { name: "Full screen", exact: true })
      .first()
      .click();
    await dialog.waitFor({ state: "visible", timeout: 5000 });
  }

  /** Leave full screen; the presentation closes with it. */
  async function leaveFullScreen() {
    await page.evaluate(async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
    });
    await dialog.waitFor({ state: "detached", timeout: 5000 });
  }

  /** The chrome shows on hover: the tag's stepper, the size chip, the pill. */
  async function chromeIsThere(where: string) {
    await dialog.hover();
    r.ok(
      `the version stepper is on the ${where} presentation`,
      (await dialog.getByRole("group", { name: "Version" }).count()) === 1,
    );
    r.ok(
      `the size chip is on the ${where} presentation`,
      (await dialog.getByRole("button", { name: "Size and zoom" }).count()) ===
        1,
    );
    if (option) {
      r.ok(
        `the options pill is on the ${where} presentation`,
        (await dialog.getByLabel("Prototype options").count()) === 1,
      );
    }
  }

  // --- Full screen, with two frames: ← / → flip ---------------------------
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  await page
    .locator(canvasFrameSelector({ letter: "B", status: "found" }))
    .waitFor({ state: "visible", timeout: 10_000 });
  await fullScreenA();
  // The fullscreen transition is async — poll rather than sampling once.
  const fullscreened = await page
    .waitForFunction(() => document.fullscreenElement !== null, null, {
      timeout: 5000,
    })
    .then(
      () => true,
      () => false,
    );
  r.ok("full screen hands the stage to the browser", fullscreened);
  const box = await dialog.boundingBox();
  r.ok(
    "the presentation fills the viewport",
    box != null &&
      viewport != null &&
      box.width >= viewport.width - 1 &&
      box.height >= viewport.height - 1,
    `dialog ${JSON.stringify(box)} viewport ${JSON.stringify(viewport)}`,
  );
  r.ok(
    "the presentation shows the prototype",
    (await dialog.locator("iframe").count()) >= 1,
  );
  await dialog.hover();
  r.ok(
    "the tag says 1 of 2",
    await dialog.getByText("1 of 2 · ← →").isVisible(),
  );
  await chromeIsThere("full-screen");
  await snap(page, out, "full-screen");
  // Keys go to the app document, not the prototype's iframe.
  await dialog.getByText("1 of 2 · ← →").click();
  await page.keyboard.press("ArrowRight");
  const flipped = await dialog
    .getByText("2 of 2 · ← →")
    .waitFor({ state: "visible", timeout: 5000 })
    .then(
      () => true,
      () => false,
    );
  r.ok("→ flips to frame B in place", flipped);
  r.ok(
    "…showing B's screen",
    (await dialog.locator(canvasFrameSelector({ letter: "B" })).count()) === 1,
  );
  await page.keyboard.press("ArrowLeft");
  const back = await dialog
    .getByText("1 of 2 · ← →")
    .waitFor({ state: "visible", timeout: 5000 })
    .then(
      () => true,
      () => false,
    );
  r.ok("← flips back to frame A", back);
  await page.keyboard.press("ArrowRight");
  await dialog
    .getByText("2 of 2 · ← →")
    .waitFor({ state: "visible", timeout: 5000 });

  await leaveFullScreen();
  r.ok(
    "leaving full screen closes the presentation",
    (await dialog.count()) === 0,
  );

  // --- F presents the selected frame --------------------------------------
  // Leaving selected B (the frame last on show), so F presents B.
  await page.mouse.move(5, 5);
  await page.keyboard.press("f");
  await dialog.waitFor({ state: "visible", timeout: 5000 });
  const fB = await dialog
    .locator(canvasFrameSelector({ letter: "B" }))
    .waitFor({ state: "attached", timeout: 5000 })
    .then(
      () => true,
      () => false,
    );
  r.ok(
    "leaving selected the frame last on show, and F presents it (B)",
    fB,
    `frames in the presentation: ${String(await dialog.locator("[data-canvas-frame]").count())}`,
  );
  await page.waitForTimeout(500);
  await leaveFullScreen();

  // --- Full screen keeps its popups working -------------------------------
  await fullScreenA();
  // The load-bearing one: the options pill still WORKS inside the
  // fullscreened element — its popover opens there, and a chip reloads the
  // frame on the picked variant.
  if (option && otherValue !== undefined) {
    await dialog.getByLabel("Prototype options").click();
    const group = dialog.getByRole("radiogroup", {
      name: humanizeToken(option.name),
    });
    await group.waitFor({ state: "visible", timeout: 5000 });
    await group
      .getByRole("radio", { name: new RegExp(`^${humanizeToken(otherValue)}`) })
      .click();
    const switched = await waitFor(
      () => Promise.resolve(frameUrl(page)),
      (url) =>
        url !== undefined && url.includes(`${option.name}=${otherValue}`),
      { timeoutMs: 15_000 },
    );
    r.ok(
      `a chip switches ${option.name} to "${otherValue}" while full screen`,
      switched.ok,
      switched.value,
    );
    // Close the popover by its trigger: under full screen, Escape would leave.
    await dialog.getByLabel("Prototype options").click();
  }
  // The version list opens inside the fullscreened presentation (its portal
  // host).
  await dialog.hover();
  const versionLabel = dialog
    .getByRole("group", { name: "Version" })
    .getByRole("button", { name: /^(v\d+|Live|Unknown)/ });
  await versionLabel.click();
  const list = dialog.getByText("Versions", { exact: true });
  const listShown = await list
    .waitFor({ state: "visible", timeout: 5000 })
    .then(
      () => true,
      () => false,
    );
  r.ok("the version list opens inside the full-screen presentation", listShown);
  await snap(page, out, "full-screen-version-list");
  await versionLabel.click();
  await leaveFullScreen();

  // --- Open in a new tab: the Responsive present page --------------------
  const opened = context.waitForEvent("page", { timeout: 5000 });
  await frameA.hover();
  // Frame A's header comes first, so its button is the first one.
  await page
    .getByRole("button", { name: "Open in a new tab", exact: true })
    .first()
    .click();
  const tab = await opened;
  await tab.setViewportSize({ width: 1111, height: 777 });
  await tab.waitForLoadState("domcontentloaded");
  const tabUrl = new URL(tab.url());
  r.ok(
    "the new tab opens frame A's present page (live, shared picks) at the Responsive size, chromeless",
    tabUrl.pathname === `/prototypes/present/${name}/live/responsive` &&
      tabUrl.searchParams.get("embed") === "1",
    tab.url(),
  );
  await tab
    .locator(canvasFrameSelector({ letter: "A", status: "found" }))
    .waitFor({ state: "attached", timeout: 15_000 });
  r.ok(
    "the new tab draws no app tab bar",
    (await tab.locator("[data-app-tab]").count()) === 0,
  );
  const fills = await waitFor(
    async () => (await tab.locator("iframe").first().boundingBox())?.width,
    (w) => w !== undefined && Math.abs(w - 1111) <= 2,
    { timeoutMs: 10_000 },
  );
  r.ok(
    "the new tab's frame fills the tab's width",
    fills.ok,
    String(fills.value),
  );
  if (option) {
    await tab.locator(canvasFrameSelector({ letter: "A" })).hover();
    const tabPicker = tab.getByLabel("Prototype options");
    await tabPicker.waitFor({ state: "visible", timeout: 15_000 });
    r.ok("the options pill is on the new-tab page", true);
    await snap(tab, out, "new-tab");
    // The full-screen step above left `otherValue` picked: switch back.
    await tabPicker.click();
    const group = tab.getByRole("radiogroup", {
      name: humanizeToken(option.name),
    });
    await group.waitFor({ state: "visible", timeout: 5000 });
    await group
      .getByRole("radio", {
        name: new RegExp(`^${humanizeToken(option.default)}`),
      })
      .click();
    const switched = await waitFor(
      () =>
        Promise.resolve(
          tab
            .frames()
            .find((f) => f.url().includes(`/api/prototypes/${name}/`))
            ?.url(),
        ),
      (url) =>
        url !== undefined && !url.includes(`${option.name}=${otherValue}`),
      { timeoutMs: 15_000 },
    );
    r.ok(
      `a chip switches ${option.name} back to "${option.default}" in the new tab`,
      switched.ok,
      switched.value,
    );
  } else {
    await snap(tab, out, "new-tab");
  }
  await tab.close();

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
  await r.finish();
});
