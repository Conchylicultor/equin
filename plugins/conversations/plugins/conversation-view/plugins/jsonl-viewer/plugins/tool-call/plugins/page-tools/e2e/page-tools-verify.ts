/**
 * Verifies the page MCP tool rows render through their own renderers rather
 * than the generic JSON fallback.
 *
 * Point it at a conversation whose transcript contains the calls:
 *
 *   ./singularity run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/page-tools/e2e/page-tools-verify.ts \
 *     --conv conv-1786847461-nwja
 *
 * A rendered row is recognized by what only the renderer paints: content beside
 * the tool-name badge in the card header (the page chip, and for `edit_page` the
 * replace-all badge). The generic fallback paints a bare badge and a raw JSON
 * body, so "the header carries more than the tool name" is the discriminating
 * signal — not "a row exists".
 */
import {
  pathUrl,
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const TOOLS = [
  "mcp__equin__read_page",
  "mcp__equin__write_agent_note",
  "mcp__equin__edit_page",
] as const;

const convId = requireArg(
  "conv",
  "usage: page-tools-verify.ts --conv <conversation id whose transcript calls the page tools>",
);
const r = report("page-tools-verify");

await withBrowser(async (h) => {
  const { page, captured } = await h.session();
  await page.goto(pathUrl(`/agents/c/${convId}`), {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(8000);

  // Two passes on purpose. The first scrolls each row into view and shoots it;
  // the second re-reads the headers once everything the rows depend on has
  // landed — so the assertion is about the settled row, not about how far the
  // pages resource happened to have got when that row first painted.
  const present: { tool: string; count: number }[] = [];
  for (const tool of TOOLS) {
    const badges = page.getByText(tool, { exact: true });
    const count = await badges.count();
    if (count === 0) {
      r.note(`${tool}: no rows in this transcript`);
      continue;
    }
    present.push({ tool, count });
    // Plain `scrollIntoView`, not Playwright's `scrollIntoViewIfNeeded`: the
    // transcript's stick-to-bottom scroller keeps pulling the viewport back, so
    // the "element settled" wait that helper performs never converges.
    await badges
      .first()
      .evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: `/tmp/page-tools-${tool.replace("mcp__equin__", "")}.png`,
    });
  }

  for (const { tool, count } of present) {
    // The card header row — the badge's nearest ancestor that also holds the aside.
    const header = page
      .getByText(tool, { exact: true })
      .first()
      .locator("xpath=ancestor::div[2]");
    const text = (await header.innerText()).replace(/\s+/g, " ").trim();
    r.ok(
      `${tool} renders its own row (${count} in transcript)`,
      text.length > tool.length,
      `header reads "${text}"`,
    );
    r.note(`header: ${text}`);
  }

  // The write report is the page-specific half of these rows: how much of the
  // page the write actually moved. Open one write row and look for it.
  const writeBadge = page
    .getByText("mcp__equin__write_agent_note", { exact: true })
    .first();
  if ((await writeBadge.count()) > 0) {
    await writeBadge.evaluate((el) => el.scrollIntoView({ block: "center" }));
    // The whole card, header + collapsible body: CollapsibleCard's root is the
    // one ancestor carrying the `group` class its hover chrome keys on.
    const card = writeBadge.locator(
      'xpath=ancestor::div[contains(@class,"group")][1]',
    );
    // Dispatched on the card's own toggle, not clicked at a coordinate. The
    // header is a stack of deliberately overlapping layers — a click-through
    // label over a full-bleed toggle, with the page chip opting back in on top
    // — so every real click point in that row belongs to something else.
    await card
      .getByRole("button", { name: "Expand" })
      .first()
      .dispatchEvent("click");
    await page.waitForTimeout(1200);
    const body = (await card.innerText()).replace(/\s+/g, " ").trim();
    r.ok(
      "write_agent_note shows what the write changed",
      /no change|unchanged/.test(body),
      `card reads "${body.slice(0, 200)}"`,
    );
    const reportChip = card.getByText(/unchanged|no change/).first();
    if ((await reportChip.count()) > 0) {
      await reportChip.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(600);
    }
    await page.screenshot({ path: "/tmp/page-tools-write-open.png" });
  }

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join("; "),
  );
});

await r.finish();
