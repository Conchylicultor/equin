// E2E verification: a non-image file attached to a prompt becomes a file chip
// that opens its preview BESIDE the surface holding the prompt.
//
// Flow, on the agent manager's home (/agents):
//   1. attach a text file through the composer's "+" → a file chip appears;
//   2. click the chip → the preview opens as a column next to the home (the
//      composer is still on screen), not in its place;
//   3. reload → the chip is restored from the draft and renders (no crashed
//      decorator);
//   4. select all + copy, paste at the end → a second chip (copied as a node).
// Then the same attach + click from the Improve popover over Pages.
//
// Usage: ./singularity run plugins/apps/plugins/file-explorer/plugins/attachment-preview/e2e/attach-and-open.ts [--headed]
import type { Locator, Page } from "playwright";
import {
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/attachment-preview-e2e";
const FILE = "e2e-notes.txt";
const CRASH = "An error was thrown.";

async function attach(page: Page, scope: Locator, name: string) {
  const chooser = page.waitForEvent("filechooser");
  await scope.getByRole("button", { name: "Attach files" }).first().click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(`hello from ${name}\n`),
  });
}

const chipIn = (scope: Locator, name: string) =>
  scope.locator('[contenteditable="true"]').getByText(name, { exact: true });

await withBrowser(async (h) => {
  const { page } = await h.session();
  const r = report("attachment chips open their preview beside the prompt");

  // ── Agent manager home ────────────────────────────────────────────────
  await page.goto(pathUrl("/agents"), { waitUntil: "domcontentloaded" });
  const body = page.locator("body");
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor({ state: "visible", timeout: 60_000 });
  // Start from an empty draft so the counts below are this run's.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");

  await attach(page, body, FILE);
  const chip = chipIn(body, FILE);
  await chip.first().waitFor({ state: "visible", timeout: 30_000 });
  r.ok("the + attaches a file as a chip", true);
  await snap(page, OUT, "home-attached");

  await chip.first().click();
  await page.waitForURL(/\/attachment\//, { timeout: 15_000 });
  await page
    .getByText("hello from", { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await snap(page, OUT, "home-opened");
  r.ok(
    "the preview opens beside the home — the composer stays on screen",
    await editor.isVisible(),
    page.url(),
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await chipIn(body, FILE)
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(3_000); // let the deferred plugin tiers land
  await snap(page, OUT, "home-reloaded");
  r.ok(
    "after a reload the chip renders (no crashed decorator)",
    (await page.getByText(CRASH).count()) === 0 &&
      (await chipIn(body, FILE).count()) === 1,
  );

  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  const ringed = await editor.locator("[data-token-selected]").count();
  await snap(page, OUT, "home-selected");
  r.ok(
    "select-all selects the chip as one object",
    ringed >= 1,
    `ringed=${ringed}`,
  );
  // Headless Chromium has no system clipboard to round-trip through, so the
  // copy and the paste are real ClipboardEvents sharing one DataTransfer —
  // exactly what Lexical's own copy/paste handlers read and write.
  const copied = await editor.evaluate((el) => {
    const data = new DataTransfer();
    el.dispatchEvent(
      new ClipboardEvent("copy", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
    (window as unknown as { __e2eClip: DataTransfer }).__e2eClip = data;
    return `${data.types.join(",")} plain=${JSON.stringify(data.getData("text/plain"))}`;
  });
  r.note(`copied formats: ${copied}`);
  await page.keyboard.press("ArrowRight");
  // Lexical adopts the collapsed caret on the async selectionchange; pasting
  // before that would replace the still-selected chip.
  await editor
    .locator("[data-token-selected]")
    .waitFor({ state: "detached", timeout: 5_000 });
  await editor.evaluate((el) => {
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: (window as unknown as { __e2eClip: DataTransfer })
          .__e2eClip,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await chipIn(body, FILE)
    .nth(1)
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch((err: unknown) => {
      if (!(err instanceof Error && err.name === "TimeoutError")) throw err;
    });
  const pasted = await chipIn(body, FILE).count();
  await snap(page, OUT, "home-pasted");
  r.ok("copy + paste duplicates the chip", pasted === 2, `chips=${pasted}`);

  // Leave the home draft empty again.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");

  // ── Improve popover over Pages ────────────────────────────────────────
  await page.goto(pathUrl("/pages"), { waitUntil: "domcontentloaded" });
  const improve = page.getByRole("button", { name: "Improve" }).first();
  await improve.waitFor({ state: "attached", timeout: 60_000 });
  const bar = page.locator('[data-source*="floating-action"]').first();
  if (await bar.isVisible()) await bar.hover();
  await improve.click();
  const popover = page.getByRole("dialog").last();
  await popover
    .locator('[contenteditable="true"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  const before = page.url();
  await attach(page, popover, FILE);
  const popChip = chipIn(popover, FILE);
  await popChip.first().waitFor({ state: "visible", timeout: 30_000 });
  await snap(page, OUT, "pages-attached");
  await popChip.first().click();
  await page.waitForURL(/\/attachment\//, { timeout: 15_000 });
  await page
    .getByText("hello from", { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await snap(page, OUT, "pages-opened");
  r.ok(
    "from Improve over Pages, the preview is appended to the Pages route",
    page.url().startsWith(before.replace(/\/$/, "")) &&
      page.url().includes("/attachment/"),
    `${before} → ${page.url()}`,
  );

  await r.finish();
});
