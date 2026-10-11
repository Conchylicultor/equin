// Verifies `<go>` end to end, without sending anything:
//   1. in the agent's reply, one-line <go>s render inline (inside a paragraph)
//      as one [text | ▶] unit — including one standing on a line of its own;
//   2. a checklist row toggles on click, and Reset appears once it differs;
//   3. clicking an inline Go's text puts the <go> region into the composer:
//      the words, tinted, closed by a ✕ cap (the draft is cleared afterwards);
//   4. a user message holding a <go> renders it as an accepted, tinted region.
//
// The conversation must hold an assistant reply with an inline <go> and a <go>
// checklist block; 4 additionally needs a user message containing a <go>.
//
// Usage:
//   ./singularity run plugins/active-data/plugins/go/e2e/go-verify.ts \
//     --conv <conversationId> [--out /tmp/go] [--headed]

import {
  arg,
  numArg,
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const CONV = requireArg("conv", "usage: go-verify.ts --conv <conversationId>");
const OUT = arg("out", "/tmp/go");
const waitMs = numArg("wait", 8000);

const r = report("active-data go");

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width: 1280, height: 1000 } });
  await page.goto(pathUrl(`/agents/c/${CONV}`));
  await page.waitForTimeout(waitMs);

  // The transcript is windowed: the reply holding the go block mounts only
  // near the viewport, so find its checklist rows first and bring them in.
  const rows = page.getByRole("checkbox");
  for (let i = 0; i < 30 && (await rows.count()) === 0; i++) {
    await page.waitForTimeout(500);
  }
  r.ok("checklist rows rendered", (await rows.count()) > 0);
  if ((await rows.count()) === 0) return;
  const row = rows.first();
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await snap(page, OUT, "reply");

  // An inline Go's ▶ cap is a role=button span labelled Send.
  // Polled: the reply's rows hydrate in after its checklist scrolled in.
  const inlineSends = page.locator(`p [role="button"][aria-label="Send"]`);
  for (let i = 0; i < 20 && (await inlineSends.count()) === 0; i++) {
    await page.waitForTimeout(500);
  }
  const inParagraph = await inlineSends.count();
  r.note(`${inParagraph} inline Go chip(s) in paragraphs`);
  r.ok("one-line <go>s render inline, inside their paragraph", inParagraph > 0);

  const before = await row.getAttribute("aria-checked");
  await row.click();
  await page.waitForTimeout(300);
  r.ok(
    "clicking a row toggles it",
    (await row.getAttribute("aria-checked")) !== before,
  );
  r.ok(
    "Reset appears once the picks differ from the agent's",
    (await page.getByRole("button", { name: "Reset" }).count()) > 0,
  );

  // Clicking an inline Go's text is its edit half.
  await page.locator(`p [title="Edit before sending"]`).first().click();
  await page.waitForTimeout(500);
  const editor = page.locator('[contenteditable="true"]').last();
  const draftHasCap =
    (await editor.locator('[aria-label="Remove the suggestion"]').count()) > 0;
  const highlighted = await editor.evaluate(
    (el) => el.querySelectorAll(".bg-primary\\/5").length,
  );
  r.ok("clicking the text puts a ✕-capped region in the draft", draftHasCap);
  r.ok("the region's words are tinted", highlighted > 0);
  await snap(page, OUT, "draft");
  // Leave no draft behind.
  await editor.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");

  // A user message with a <go>: the GoEcho region wears the Go tint.
  const echoes = await page
    .locator(".bg-message-card")
    .evaluateAll(
      (cards) => cards.filter((c) => c.querySelector(".bg-primary\\/5")).length,
    );
  r.note(`${echoes} user message(s) render an accepted <go>`);
});
