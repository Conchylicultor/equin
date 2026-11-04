/**
 * Screenshots one transcript row per named tool, opened — for eyeballing a
 * tool renderer on a real conversation. Each tool's first row is scrolled into
 * view in the middle of the viewport, expanded, and shot to `<out>-<tool>.png`; the run fails when a named
 * tool has no row, or when a row is the generic fallback (an investigate
 * action, which the strip shows only on unmatched rows).
 *
 *   ./equin run plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/e2e/tool-rows-shot.ts \
 *     --conv conv-1793801432-jfjxdv --tools query_db,get_timeline [--out /tmp/tool-rows]
 *
 * A tool is named as its badge reads without the server (`query_db`, `Bash`).
 */
import {
  arg,
  pathUrl,
  report,
  requireArg,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const convId = requireArg(
  "conv",
  "usage: tool-rows-shot.ts --conv <conversation id> --tools <tool,tool> [--out <prefix>]",
);
const tools = requireArg("tools", "--tools <tool,tool>")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const out = arg("out") ?? "/tmp/tool-rows";
const r = report("tool-rows-shot");

await withBrowser(async (h) => {
  const { page, captured } = await h.session();
  await page.goto(pathUrl(`/agents/c/${convId}`), {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(8000);

  for (const tool of tools) {
    // The badge reads `<server>:<tool>` for an MCP tool, the bare name else.
    const badge = page.getByText(new RegExp(`^(\\w+:)?${tool}$`)).first();
    if ((await badge.count()) === 0) {
      r.ok(`${tool}: a row in the loaded transcript`, false, "none found");
      continue;
    }
    // The card: the badge's nearest ancestor holding the card's own toggle
    // (the full-bleed Expand / Collapse button under the header layers).
    const marker = `tool-row-${tool}`;
    await badge.evaluate((el, m) => {
      let c: HTMLElement | null = el as HTMLElement;
      while (
        c &&
        !c.querySelector(
          ':scope button[aria-label="Expand"], :scope button[aria-label="Collapse"]',
        )
      )
        c = c.parentElement;
      c?.setAttribute("data-tool-row", m);
    }, marker);
    const card = page.locator(`[data-tool-row="${marker}"]`);
    const expand = card.locator('button[aria-label="Expand"]').first();
    if ((await expand.count()) > 0) await expand.dispatchEvent("click");
    await page.waitForTimeout(1500);
    // Wheel up first: the transcript sticks to its bottom until the reader
    // scrolls, and would pull a plain scroll back.
    await card.evaluate((el) => {
      el.closest("[data-pane-scroll]")?.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -100, bubbles: true }),
      );
      el.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}-${tool}.png` });
    const text = (await card.innerText()).replace(/\s+/g, " ").trim();
    r.note(`${tool}: ${text.slice(0, 300)}`);
    r.ok(
      `${tool}: rendered by its own renderer`,
      (await card.getByRole("button", { name: /investigate/i }).count()) === 0,
      "the row carries the fallback's investigate action",
    );
  }

  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join("; "),
  );
});
await r.finish();
