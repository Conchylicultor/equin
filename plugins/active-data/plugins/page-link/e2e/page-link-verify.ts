// Verifies the `block-<id>` inline chip: a block id written in a conversation
// renders as a labelled chip, and clicking it opens a column beside the
// conversation: the page (`…/page/<pageId>`) for a page id, the block view
// (`…/block/<blockId>`) for a content-block id.
//
// Both id kinds are asserted — a PAGE id (resolved client-side from the pages
// resource) and a CONTENT-block id (resolved through GET /api/blocks/:id/page),
// since only the second exercises the server lookup.
//
// The conversation must contain the ids in its transcript; pass the ones you
// seeded it with.
//
// Usage:
//   ./singularity run plugins/active-data/plugins/page-link/e2e/page-link-verify.ts \
//     --conv <conversationId> --page <block-…> [--block <block-…>] \
//     [--url http://<worktree>.localhost:9000] [--headed]

import {
  agentFetch,
  arg,
  numArg,
  pathUrl,
  report,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const USAGE =
  "usage: page-link-verify.ts --conv <conversationId> --page <block-id> [--block <content-block-id>]";
const CONV = requireArg("conv", USAGE);
const PAGE_ID = requireArg("page", USAGE);
const BLOCK_ID = arg("block");
const OUT = "/tmp/claude-501/page-link";
const waitMs = numArg("wait", 4000);

const r = report("active-data page-link");

await withBrowser(async (h) => {
  const { page } = await h.session({ colorScheme: "dark" });

  await page.goto(pathUrl(`/agents/c/${CONV}`));
  await page.waitForTimeout(waitMs);
  await snap(page, OUT, "1-conversation");

  // The chip is the only element carrying the id in its `data-tooltip` (the raw text
  // fallback carries none), so a hit here IS the chip.
  async function chipFor(id: string) {
    const chips = page.locator(`button[data-tooltip*="${id}"]`);
    // Polled, not `waitFor`: an absent chip is the outcome the next line
    // ASSERTS on, so it must not arrive as a thrown timeout. The content-block
    // lookup is a fetch, so the chip can appear a beat after first paint.
    for (let i = 0; i < 20 && (await chips.count()) === 0; i++) {
      await page.waitForTimeout(500);
    }
    return chips.first();
  }

  async function verify(kind: string, id: string, expectedPath: string) {
    const chip = await chipFor(id);
    const count = await page.locator(`button[data-tooltip*="${id}"]`).count();
    r.ok(`${kind}: chip rendered for ${id}`, count > 0);
    if (count === 0) return;

    const label = (await chip.innerText()).trim();
    r.note(
      `${kind}: label="${label}" tooltip="${await chip.getAttribute("data-tooltip")}"`,
    );
    r.ok(
      `${kind}: chip is labelled, not the raw id`,
      label.length > 0 && label !== id,
    );

    await chip.click();
    await page.waitForTimeout(2000);
    await snap(page, OUT, `${kind}-opened`);

    r.ok(
      `${kind}: click opened the ${expectedPath} column`,
      page.url().includes(expectedPath),
      `url=${page.url()}`,
    );
    const ids: string[] = await page
      .locator("[data-pane-id]")
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute("data-pane-id") ?? "?"),
      );
    r.note(`${kind}: columns=${JSON.stringify(ids)}`);
    r.ok(
      `${kind}: the conversation stayed open beside it`,
      ids.includes("conversation"),
    );

    // Back to the bare conversation for the next case.
    await page.goto(pathUrl(`/agents/c/${CONV}`));
    await page.waitForTimeout(waitMs);
  }

  await verify("page-id", PAGE_ID, `/page/${PAGE_ID}`);
  if (BLOCK_ID) {
    // A content block opens as a page of its own — the block view — once the
    // endpoint has resolved it to the page holding it.
    const res = await agentFetch(`/api/blocks/${BLOCK_ID}/page`);
    const body = (await res.json()) as { found: boolean; pageId?: string };
    r.ok(
      `content-block: endpoint resolved ${BLOCK_ID}`,
      body.found,
      JSON.stringify(body),
    );
    if (body.found)
      await verify("content-block", BLOCK_ID, `/block/${BLOCK_ID}`);
  }
});

await r.finish();
