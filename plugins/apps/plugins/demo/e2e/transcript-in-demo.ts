/**
 * A demo transcript draws its tool calls exactly as a real conversation does.
 *
 * The demo used to drop the per-tool renderers without a word: its
 * composition negated the file explorer, the negative cascaded through the
 * file-peek pane into the file-path chip and every renderer that draws one
 * (Read, Write, Edit, compaction, attachments…), and each of those cards fell
 * back to the generic tool card — the header with no path.
 *
 * In `/demo` (it opens on the practice-timer conversation), it:
 *
 *  1. waits for the transcript, and checks every Read / Write / Edit card
 *     carries its file path chip (`data-file-path`, non-empty) — there is at
 *     least one of each kind the seed holds;
 *  2. clicks the first path: the file-peek pane opens beside the
 *     conversation, naming the file, and says the file cannot be read here
 *     (a checkout file needs the computer) — never a blank pane;
 *
 * and asserts no page error and no console error throughout.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/demo/e2e/transcript-in-demo.ts [--out /tmp/demo-transcript] [--headed]
 */
import type { Page } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/demo-transcript";
/** How long the worker's transcript read gets to render. */
const RENDER_TIMEOUT_MS = 30_000;
/** The tool cards that draw a file path chip. */
const PATH_TOOLS = ["Read", "Write", "Edit"] as const;

interface PathCard {
  tool: string;
  /** The chip's path, or null when the card's header has none. */
  path: string | null;
}

/**
 * Every Read / Write / Edit card on screen and the path its header shows. A
 * card is found by its tool badge; its header is the nearest ancestor holding
 * the card's Expand / Collapse toggle.
 */
async function pathCards(page: Page): Promise<PathCard[]> {
  return page
    .locator("[data-app-embed]")
    .first()
    .evaluate((root, tools: readonly string[]) => {
      const cards: { tool: string; path: string | null }[] = [];
      for (const badge of root.querySelectorAll("span")) {
        const tool = badge.textContent?.trim() ?? "";
        if (badge.childElementCount !== 0 || !tools.includes(tool)) continue;
        let header: Element | null = badge.parentElement;
        while (
          header &&
          !header.querySelector(
            'button[aria-label="Expand"], button[aria-label="Collapse"]',
          )
        )
          header = header.parentElement;
        if (!header) continue;
        const chip = header.querySelector("[data-file-path]");
        cards.push({
          tool,
          path: chip?.getAttribute("data-file-path") ?? null,
        });
      }
      return cards;
    }, PATH_TOOLS);
}

await withBrowser(async (h) => {
  const r = report("demo: transcript tool cards");
  const { page, captured } = await h.session();

  await boot(page, pathUrl("/demo"), {
    marker: 'button:has-text("Conversations")',
  });

  // 1. Every path-drawing card carries its path.
  const settled = await waitFor(
    () => pathCards(page),
    (cards) => cards.length > 0 && cards.every((c) => c.path !== null),
    { timeoutMs: RENDER_TIMEOUT_MS },
  );
  await snap(page, OUT, "1-transcript");
  const cards = settled.value;
  r.ok(
    "the demo transcript draws Read / Write / Edit cards",
    cards.length > 0,
    "no such card on screen",
  );
  const pathless = cards.filter((c) => !c.path);
  r.eq("every Read / Write / Edit card shows its file path", pathless, []);
  r.note(
    `${cards.length} cards: ${cards.map((c) => `${c.tool} ${c.path}`).join(", ")}`,
  );

  // 2. A path opens the file-peek pane, which says why it shows no content.
  const first = cards.find((c) => c.path);
  if (first?.path) {
    const name = first.path.slice(first.path.lastIndexOf("/") + 1);
    await page
      .locator(`[data-app-embed] [data-file-path="${first.path}"]`)
      .first()
      .click();
    // The opened pane's own text: its file's name in the header, and the
    // reason it shows no content.
    const pane = page
      .locator('[data-app-embed] [data-pane-id="file-peek"]')
      .first();
    const opened = await waitFor(
      async () => ((await pane.count()) > 0 ? await pane.innerText() : ""),
      (text) => text.includes(name) && text.includes("isn't available"),
      { timeoutMs: RENDER_TIMEOUT_MS },
    );
    await snap(page, OUT, "2-file-peek");
    r.ok(
      `clicking ${first.path} opens its file-peek pane, saying it needs the computer`,
      opened.value.includes(name) && opened.value.includes("isn't available"),
      `file-peek pane text: ${JSON.stringify(opened.value.slice(0, 300))}`,
    );
  }

  r.eq("no page errors", captured.pageErrors, []);
  r.eq("no console errors", captured.consoleErrors, []);
  await r.finish();
});
