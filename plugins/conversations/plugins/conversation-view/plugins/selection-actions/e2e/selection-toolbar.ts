/**
 * Selecting agent text shows the selection toolbar; Quote puts it in the prompt.
 *
 * Triple-clicks the last paragraph of an agent reply, checks the
 * toolbar appears with Quote and the configured quick answers, screenshots it,
 * hovers the quick-answer ✎ and screenshots the panel of every answer, then
 * clicks Quote and checks the prompt editor now holds a `> ` quote. Never
 * clicks a ➤ — that would send a turn to the conversation.
 *
 *   ./equin run plugins/conversations/plugins/conversation-view/plugins/selection-actions/e2e/selection-toolbar.ts \
 *     --conv <id> [--out /tmp/sel] [--headed]
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const EDITOR = '[data-lexical-editor="true"]';
const AGENT_ROW = '[data-event-key^="assistant-text:"]';

await withBrowser(async (h) => {
  const convId = requireArg(
    "conv",
    "--conv <conversation-id> [--out <prefix>]",
  );
  const out = arg("out") ?? "/tmp/selection-toolbar";
  const r = report("selection toolbar");
  const { page } = await h.session();
  const url = pathUrl(`/agents/c/${convId}`);
  await boot(page, url, {
    marker: AGENT_ROW,
    settleMs: 1500,
    timeoutMs: 90_000,
  });

  const para = page.locator(`${AGENT_ROW} p`).last();
  await para.scrollIntoViewIfNeeded();
  // A triple-click selects the paragraph with a real pointer press and
  // release — the path a person takes, where the toolbar waits for the release.
  await para.click({ clickCount: 3, position: { x: 4, y: 8 } });
  const selected = await page.evaluate(
    () => window.getSelection()?.toString() ?? "",
  );
  r.note(`selected: ${JSON.stringify(selected.slice(0, 80))}`);

  const quote = page.getByRole("button", { name: "Quote", exact: true });
  await quote
    .waitFor({ state: "visible", timeout: 5000 })
    .catch((err: unknown) => {
      if (!(err instanceof Error)) throw err;
    });
  const shown = await quote.isVisible();
  r.ok("toolbar shows Quote over the selection", shown);
  const sends = await page.getByRole("button", { name: /^Send: / }).count();
  r.note(`quick-answer send halves: ${sends}`);
  await snap(page, out, "toolbar");
  if (!shown) return r.finish();

  const trigger = page.locator("[data-ui-owner^='Actions@'] .group\\/fa");
  await trigger.hover();
  await page.waitForTimeout(400);
  const panelOpen = await trigger.evaluate((el) =>
    el.hasAttribute("data-open"),
  );
  r.ok("✎ opens the panel of every quick answer", panelOpen);
  r.ok(
    "selection survives the hover",
    await page.evaluate(() => (window.getSelection()?.toString() ?? "") !== ""),
  );
  await snap(page, out, "panel");

  await quote.click();
  const text = await page
    .locator(EDITOR)
    .first()
    .evaluate((el) => el.textContent ?? "");
  r.ok(
    "prompt holds the quote",
    text.includes(`> ${selected.trim().split("\n")[0]}`),
  );
  r.note(`prompt: ${JSON.stringify(text.slice(0, 120))}`);
  const closed = await quote
    .waitFor({ state: "hidden", timeout: 3000 })
    .then(() => true)
    .catch((err: unknown) => {
      if (!(err instanceof Error)) throw err;
      return false;
    });
  r.ok("toolbar closes after quoting", closed);
  await snap(page, out, "quoted");
  await r.finish();
});
