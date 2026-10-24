// Verifies the conversation-toolbar Pages toggle and the tree column's
// take-over navigation: from a conversation, the button opens the page tree as
// a column TO THE RIGHT (the conversation stays), clicking a page row REPLACES
// that column with the page (the chain stays two columns, not three), the
// page's title-bar back button puts the tree back in the same column, and
// clicking the toggle again closes the tree. Dumps the Miller column chain
// (`[data-pane-id]`) at each step.
//
// Usage:
//   ./equin run plugins/apps/plugins/agent-manager/plugins/pages-nav/e2e/pages-tree-verify.ts \
//     --conv <conversationId> [--url http://<worktree>.localhost:9000] [--headed]

import {
  numArg,
  pathUrl,
  requireArg,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const CONV = requireArg(
  "conv",
  "usage: pages-tree-verify.ts --conv <conversationId> [--url <deploy>] [--wait <ms>]",
);
const OUT = "/tmp/claude-501/pages-tree";
const waitMs = numArg("wait", 3500);

await withBrowser(async (h) => {
  const { page } = await h.session({ colorScheme: "dark" });

  const columns = () => page.locator("[data-pane-id]");
  async function dump(tag: string): Promise<string[]> {
    const ids: string[] = await columns().evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-pane-id") ?? "?"),
    );
    console.log(`[${tag}] url=${page.url()} columns=${JSON.stringify(ids)}`);
    return ids;
  }

  // The app rail's Pages app icon shares the "Pages" accessible name; only the
  // toolbar toggle carries aria-pressed, so this selector is unambiguous.
  const toggle = page.locator('button[aria-label="Pages"][aria-pressed]');

  await page.goto(pathUrl(`/agents/c/${CONV}`));
  await page.waitForTimeout(waitMs);
  await dump("1-conversation");
  console.log(
    "toggle count:",
    await toggle.count(),
    "pressed:",
    await toggle.getAttribute("aria-pressed"),
  );
  await snap(page, OUT, "1-conversation");

  await toggle.click();
  await page.waitForTimeout(1500);
  await dump("2-tree-open");
  console.log("pressed after open:", await toggle.getAttribute("aria-pressed"));
  await snap(page, OUT, "2-tree-open");

  // Click a page row inside the tree column (scoped, so the row can only come
  // from the pages-tree pane). The tree column BECOMES the page: expect
  // ["conversation", "page-detail"] — no third column.
  const treeColumn = page.locator('[data-pane-id="pages-tree"]');
  await treeColumn.getByText("Website", { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await dump("3-page-open");
  await snap(page, OUT, "3-page-open");

  // The page's own title bar leads with the way back: the same column returns
  // to the tree.
  const back = page.locator(
    '[data-pane-id="page-detail"] button[aria-label="Back to pages"]',
  );
  console.log("back button count:", await back.count());
  await back.click();
  await page.waitForTimeout(1500);
  await dump("4-back-to-tree");
  await snap(page, OUT, "4-back-to-tree");

  await toggle.click();
  await page.waitForTimeout(1500);
  await dump("5-tree-closed");
  console.log(
    "pressed after close:",
    await toggle.getAttribute("aria-pressed"),
  );
  await snap(page, OUT, "5-tree-closed");
});
