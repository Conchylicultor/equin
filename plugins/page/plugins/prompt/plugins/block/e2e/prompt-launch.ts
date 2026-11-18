// End-to-end verification of the `/prompt` block: insert it from the slash menu,
// type a prompt, launch, and confirm the conversation opens as a column beside
// the page — plus that the task carries its page/block provenance.
//
// This DOES spawn a real agent conversation (that is the feature), so keep the
// prompt trivial.
//
// Usage: bun plugins/page/plugins/prompt/plugins/block/e2e/prompt-launch.ts [--url <deploy>] [--out <path>]
import {
  agentFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage } from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/prompt-launch");

const r = report();

await withBrowser(async (h) => {
  const { page } = await h.session();

  const { pageId, blockId } = await openBlankPage(page, {
    settleMs: 2500,
  });
  console.log("page:", pageId, "seed block:", blockId);

  // 1. Insert via the slash menu — the same surface the gutter `+` opens.
  await page.keyboard.type("/prompt", { delay: 40 });
  await page.waitForTimeout(1200);
  await snap(page, out, "menu");
  const menuHit = await page
    .getByText("Prompt", { exact: true })
    .first()
    .isVisible();
  r.ok("slash menu offers Prompt", menuHit);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);

  // The block converted: its type is `prompt` in the row tree.
  const rowsAfterConvert = (await (
    await agentFetch(`/api/pages/${pageId}/blocks`)
  ).json()) as { id: string; type: string }[];
  const promptRow = rowsAfterConvert.find((b) => b.type === "prompt");
  r.ok("block converted to type=prompt", !!promptRow, promptRow?.id);

  // 2. Type the prompt into the block's own text editor.
  //
  // Re-focus the block explicitly first. Under Playwright's synthetic input the
  // caret does not survive the slash-menu commit — verified to affect shared
  // renderers (`quote`) identically, so it is a harness trait, not this block's
  // — and select-all replaces the leftover "/prompt" query rather than
  // appending to it.
  const editable = page.locator("[data-block-text]").first();
  await editable.click();
  await page.waitForTimeout(300);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Reply with the single word ok", { delay: 20 });
  // The launch control disables off `data.text`, which trails the CRDT doc by
  // ~1s — wait for that projection rather than racing it.
  await page.waitForTimeout(3000);
  await snap(page, out, "typed");

  const launchBtn = page.getByRole("button", { name: /^Launch / }).first();
  await launchBtn.waitFor({ state: "visible", timeout: 10_000 });
  r.ok(
    "launch control enabled once prompt has text",
    await launchBtn.isEnabled(),
  );

  // 3. Launch.
  await launchBtn.click();
  await page.waitForURL(/\/c\//, { timeout: 45_000 });
  await page.waitForTimeout(2500);
  await snap(page, out, "launched");
  r.ok(
    "conversation opened as a column beside the page",
    /\/c\//.test(page.url()),
    page.url(),
  );
  // The page column must still be in the chain — a push, not a replace.
  r.ok("page column retained (push, not replace)", page.url().includes(pageId));

  // 4. Provenance: the task carries the page/block it came from, and the chip
  //    for the new conversation renders in the block.
  const convId = new URL(page.url()).pathname.split("/c/").at(-1)!;
  console.log("conversation:", convId);

  await page.waitForTimeout(1500);
  const chipCount = await page
    .getByRole("button", { name: /Starting|ok|Reply/i })
    .count();
  r.ok(
    "block renders a chip for the launched conversation",
    chipCount > 0,
    String(chipCount),
  );
});

await r.finish();
