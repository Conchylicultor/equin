// Agent-authored pages, as a person sees them (research/2026-09-11-page-agent-pages.md).
//
//  U1. A page an agent minted (`edit_page` + a tagless `<agent-page>`) renders in
//      its parent as a sub-page row tinted with the agent-notes wash, and carries
//      a chip naming the conversation that created it. A human's sub-page beside
//      it is neither tinted nor chipped.
//  U2. Expanding the row keeps the tint and shows the page's content inline.
//  U3. The Pages sidebar paints the same wash on the agent page's tree row.
//  U4. `/agent-page` typed after words on a line turns that line into an agent
//      page titled with those words — tinted, and with no chip until an agent
//      writes into it.
//
// The wash is asserted by its class (`bg-info/10`, the agent-notes card's own),
// which is what the decoration contributes; the screenshots are for the eye.
//
// Manual only. Requires `./equin build` first, and a REAL conversation id
// for the chip to name (a made-up id resolves to nothing and the chip shimmers).
// Usage: ./equin run plugins/page/plugins/annotations/plugins/agent-notes/plugins/agent-page/e2e/agent-page-ui-verify.ts \
//          --conversation <conv-id> [--out /tmp/agent-page-ui]
import type { Locator, Page } from "playwright";
import {
  pageFetch,
  agentFetch,
  arg,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage } from "@plugins/page/plugins/editor/e2e";

const USAGE =
  "agent-page-ui-verify.ts --conversation <conv-id> [--out /tmp/agent-page-ui]";
const conversation = requireArg("conversation", USAGE);
const out = arg("out", "/tmp/agent-page-ui");

const PARENT_TITLE = "Agent pages UI check";
const ANCHOR = "anchor line";
const AGENT_PAGE_TITLE = "Decoder findings";
const AGENT_PAGE_BODY = "first finding";
const HUMAN_PAGE_TITLE = "Human sub-page";
const SLASH_TITLE = "Scratch";
const WASH = "bg-info/10";

const r = report("agent pages in the UI");

/** Call one MCP tool as `conversation`; the tool's text, or a thrown refusal. */
async function callTool(name: string, args: unknown): Promise<string> {
  const res = await agentFetch(`/api/mcp/${conversation}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`MCP ${name}: HTTP ${res.status} — ${raw}`);
  const payload =
    raw.startsWith("event:") || raw.startsWith("data:")
      ? raw
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim())
          .join("")
      : raw;
  const body = JSON.parse(payload) as {
    error?: { message?: string };
    result?: { isError?: boolean; content?: { text?: string }[] };
  };
  const text = body.result?.content?.[0]?.text;
  if (body.error || body.result?.isError || text === undefined)
    throw new Error(
      `MCP ${name} refused: ${body.error?.message ?? text ?? raw}`,
    );
  return text;
}

/** One same-origin JSON request through the page's browser context (its cookies, its origin). */
async function api(
  page: Page,
  method: string,
  url: string,
  body: unknown,
): Promise<unknown> {
  const res = await pageFetch(page, url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(`${method} ${url} ${res.status}: ${await res.text()}`);
  return (await res.json()) as unknown;
}

/** The editor row for a block id. */
function row(page: Page, id: string): Locator {
  return page.locator(`[data-block-id="${id}"]`).first();
}

/** Whether anything at or inside `loc` carries the agent wash class. */
async function washed(loc: Locator): Promise<boolean> {
  return loc.evaluate(
    (el, cls) =>
      el.classList.contains(cls) ||
      el.querySelector(`[class~="${cls.replace("/", "\\/")}"]`) !== null,
    WASH,
  );
}

await withBrowser(async (h) => {
  const { page } = await h.session();
  const { pageId, block } = await openBlankPage(page, { settleMs: 500 });
  await api(page, "PATCH", `/api/blocks/${pageId}`, {
    data: { title: PARENT_TITLE, icon: null },
  });
  await block.click();
  await page.keyboard.type(ANCHOR);
  // The line's text reaches its row through the ~1 s projection; edit_page reads
  // the row, so it must have landed before the anchor can be named.
  await page.waitForTimeout(2500);

  // A human's sub-page, for contrast: turn-into-page with no author.
  const humanLine = (await api(page, "POST", "/api/blocks", {
    parentId: pageId,
    type: "text",
    data: { text: [] },
  })) as { id: string };
  await api(page, "POST", `/api/blocks/${humanLine.id}/turn-into-page`, {
    title: HUMAN_PAGE_TITLE,
    seedChild: { type: "text", data: { text: [] } },
  });

  // --- U1. an agent mints a page ------------------------------------------
  const minted = JSON.parse(
    await callTool("edit_page", {
      block_id: pageId,
      old_string: ANCHOR,
      new_string:
        `${ANCHOR}\n<agent-page title="${AGENT_PAGE_TITLE}">\n` +
        `  ${AGENT_PAGE_BODY}\n  - checked decode.ts\n</agent-page>`,
    }),
  ) as { created_page_ids?: string[] };
  const agentPageId = minted.created_page_ids?.[0];
  if (agentPageId === undefined) {
    r.fail("U1: edit_page minted an agent page", JSON.stringify(minted));
    return;
  }

  const agentRow = row(page, agentPageId);
  await agentRow
    .getByText(AGENT_PAGE_TITLE)
    .waitFor({ state: "visible", timeout: 30_000 });
  r.ok(
    "U1: the agent page's row is tinted with the agent wash",
    await washed(agentRow),
  );
  const chip = agentRow
    .locator("button[title]")
    .filter({ hasNotText: AGENT_PAGE_TITLE });
  await chip.first().waitFor({ state: "visible", timeout: 30_000 });
  const chipTitle = await chip.first().getAttribute("title");
  r.ok(
    "U1: the row carries a chip naming the creating conversation",
    chipTitle !== null && chipTitle.length > 0,
    `chip title: ${chipTitle}`,
  );
  const humanRow = row(page, humanLine.id);
  await humanRow
    .getByText(HUMAN_PAGE_TITLE)
    .waitFor({ state: "visible", timeout: 30_000 });
  r.ok("U1: a human's sub-page is NOT tinted", !(await washed(humanRow)));
  await agentRow.hover();
  await snap(page, out, "collapsed");

  // --- U2. expanded ---------------------------------------------------------
  await api(page, "PATCH", `/api/blocks/${agentPageId}`, { expanded: true });
  const body = page.getByText(AGENT_PAGE_BODY, { exact: true }).first();
  await body.waitFor({ state: "visible", timeout: 30_000 });
  r.ok("U2: expanding shows the page's content inline", await body.isVisible());
  r.ok("U2: the row keeps its wash while expanded", await washed(agentRow));
  await snap(page, out, "expanded");

  // --- U4. `/agent-page` on a line with words -----------------------------
  await page.getByText(ANCHOR, { exact: true }).first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  // The menu offers actions only once the new line exists on the server.
  await page.waitForTimeout(1500);
  await page.keyboard.type(`${SLASH_TITLE} /agent-page`);
  const option = page.getByText("Agent page", { exact: true }).first();
  await option.waitFor({ state: "visible", timeout: 15_000 });
  r.ok('U4: the / menu offers "Agent page"', await option.isVisible());
  // Let the caret-anchored menu settle onto its anchor before the picture.
  await page.waitForTimeout(500);
  await snap(page, out, "slash-menu");
  await page.keyboard.press("Enter");
  const slashRow = page
    .locator("[data-block-id]")
    .filter({ has: page.getByText(SLASH_TITLE, { exact: true }) })
    .first();
  await slashRow.waitFor({ state: "visible", timeout: 30_000 });
  // The caret lands on the new row, and a row under the caret shows the caret
  // cue INSTEAD of the wash (both are a row background) — so move it away.
  await page.getByText(ANCHOR, { exact: true }).first().click();
  await page.waitForTimeout(300);
  r.ok(
    "U4: the line became a page titled with its other words, tinted",
    (await slashRow.isVisible()) && (await washed(slashRow)),
  );
  await page.waitForTimeout(1500);
  r.ok(
    "U4: a human-made agent page shows no chip before an agent writes",
    (await slashRow
      .locator("button[title]")
      .filter({ hasNotText: SLASH_TITLE })
      .count()) === 0,
  );
  await snap(page, out, "after-slash");

  // --- U3. the sidebar row --------------------------------------------------
  // On the agent page itself the content holds no agent-page rows, so any wash
  // on screen is the sidebar's tree row for it.
  await page.goto(page.url().replace(pageId, agentPageId));
  await page
    .getByText(AGENT_PAGE_BODY, { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1000);
  const sidebarWash = await page.evaluate(
    (cls) =>
      document.querySelectorAll(`[class~="${cls.replace("/", "\\/")}"]`).length,
    WASH,
  );
  r.ok(
    "U3: the sidebar paints the agent wash on the page's tree row",
    sidebarWash > 0,
    `washed elements: ${sidebarWash}`,
  );
  await snap(page, out, "sidebar");
});

await r.finish();
