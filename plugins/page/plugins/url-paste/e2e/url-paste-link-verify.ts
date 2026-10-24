// End-to-end regression for a pasted URL becoming a LINK, and for the menu that
// opens beside it. MANUAL ONLY — nothing runs this automatically.
//
// A pasted URL is inserted as a link at once, as its own undo step, and the menu
// (Keep as link / Mention / Create bookmark / Create embed) closes on ANY change
// to the block's text after that. Cmd+Z leans on both halves and on nothing
// else — there is no key interception — so none of it is visible to tsc or to a
// unit test: an insert folded into the typing run, or a listener that stopped
// firing, still compiles. Only driving the real editor shows it.
//
// Verifies, each case in a block of its own:
//   A. a URL pasted into an empty block is an `<a href>` AND the menu is open,
//      at once; Cmd+Z with the menu open closes it and leaves the block empty
//   B. Cmd+Z after typing then pasting takes back ONLY the paste — the typed
//      text survives
//   C. typing after the paste closes the menu and keeps the link
//   D. a URL pasted mid-sentence becomes a link there (no bookmark/embed rows —
//      the block holds more than the link)
//   E. Mention on https://example.com retitles the link "Example Domain" with
//      its href unchanged, and Cmd+Z brings the URL text back
//   F. Create bookmark / G. Create embed still convert the block
//
// E fetches example.com from the SERVER, so it needs the deploy to have network
// access; it is the one case that can fail for reasons outside the app.
//
// The pastes are SYNTHETIC: Playwright's `Meta+V` reads the system clipboard,
// which is shared machine state a headless run must not depend on (or clobber).
// Lexical's `PASTE_COMMAND` comes off a plain `paste` listener on the editor
// root, so a dispatched `ClipboardEvent` carrying a `DataTransfer` exercises
// exactly the same path.
//
// The script creates its OWN scratch page and deletes it on the way out.
//
// Usage:
//   ./equin run plugins/page/plugins/url-paste/e2e/url-paste-link-verify.ts [--url <deploy>] [--headed]
import type { Locator, Page } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out", "/tmp/url-paste-link-verify");

const MENU = '[data-caret-trigger="url-paste"]';
// `CaretTriggerMenu` puts `data-caret-trigger` on a `display:contents` wrapper
// whose children ARE the rows.
const ROWS = `${MENU} > *`;
const URL = "https://example.com/some-article";
const MENTION_URL = "https://example.com";
const MENTION_TITLE = "Example Domain";

// `mod+z` is the surface-level undo binding: Meta on macOS, Control elsewhere.
const UNDO = "ControlOrMeta+z";

/** Cases, one block each — the scratch page is seeded with this many. */
const CASES = ["A", "B", "C", "D", "E", "F", "G"] as const;
type Case = (typeof CASES)[number];

const r = report();

interface Row {
  id: string;
  type: string;
}

/** The editing host of the block with this id. */
function blockEl(page: Page, blockId: string): Locator {
  return page.locator(`[data-block-id="${blockId}"] [contenteditable="true"]`);
}

/** A block's rendered text, NBSP-normalised and trimmed. */
async function textOf(block: Locator): Promise<string> {
  return (await block.innerText()).replace(/\u00a0/g, " ").trim();
}

/** The block's link as `{ href, text }`, or null when it holds none. */
async function linkOf(
  block: Locator,
): Promise<{ href: string | null; text: string } | null> {
  const link = block.locator("a");
  if ((await link.count()) === 0) return null;
  return {
    href: await link.first().getAttribute("href"),
    text: (await link.first().innerText()).trim(),
  };
}

const menuOpen = async (page: Page): Promise<boolean> =>
  (await page.locator(MENU).count()) > 0;

/** The menu's row labels, in commit-index order. */
const rowLabels = (page: Page): Promise<string[]> =>
  page
    .locator(ROWS)
    .evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));

/**
 * Click a block near its RIGHT edge, past the end of its text: a plain click on
 * a link OPENS it (`ClickableLinkPlugin`), so a centred click could land on one.
 */
async function focusEnd(page: Page, block: Locator): Promise<void> {
  const box = await block.boundingBox();
  if (!box) throw new Error("block has no box");
  await block.click({ position: { x: box.width - 4, y: box.height / 2 } });
  await page.keyboard.press("End");
  await page.waitForTimeout(200);
}

/**
 * Fire a synthetic `paste` carrying `url` at the block's caret, then park the
 * pointer away from the menu — a row takes the active index on `mouseenter` by
 * design, and the menu opens right under the pointer that just clicked.
 */
async function pasteUrl(
  page: Page,
  block: Locator,
  url: string,
): Promise<void> {
  await block.evaluate((el: Element, text: string) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, url);
  await page.waitForTimeout(500);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
}

/** Move the highlight to the row labelled `label`, then press Enter. */
async function commitRow(page: Page, label: string): Promise<boolean> {
  const labels = await rowLabels(page);
  const index = labels.indexOf(label);
  if (index < 0) return false;
  for (let i = 0; i < index; i++) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(150);
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  return true;
}

async function fetchRows(page: Page, pageId: string): Promise<Row[]> {
  return page.evaluate(async (id: string) => {
    const res = await fetch(`/api/pages/${id}/blocks`);
    if (!res.ok) throw new Error(`GET blocks failed: ${res.status}`);
    return (await res.json()) as Row[];
  }, pageId);
}

await withBrowser(async (h) => {
  const { page } = await h.session();
  // `networkidle` never settles — the app holds a live notifications WebSocket
  // — and a headless Chromium on a build-loaded host needs tens of seconds to
  // boot the SPA.
  page.setDefaultTimeout(90_000);
  page.setDefaultNavigationTimeout(90_000);

  const SCRATCH_TITLE = "zz url-paste link e2e";

  await boot(page, pathUrl("/pages"), {
    marker: "text=Pages",
    timeoutMs: 90_000,
  });

  const created = await page.evaluate(
    async ({ title, count }: { title: string; count: number }) => {
      const create = async (body: unknown): Promise<string> => {
        const res = await fetch("/api/blocks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok)
          throw new Error(`create failed: ${res.status} ${await res.text()}`);
        return ((await res.json()) as { id: string }).id;
      };
      // A page block's data is `{ title, icon }` — NOT `{ text }`. A malformed
      // page row blanks the entire Pages app, sidebar included.
      const pageId = await create({
        parentId: null,
        type: "page",
        data: { title, icon: null },
      });
      // One empty text block per case, so no case inherits another's state.
      // Deleting the page cascades them away.
      const blockIds: string[] = [];
      for (let i = 0; i < count; i++)
        blockIds.push(
          await create({ parentId: pageId, type: "text", data: { text: [] } }),
        );
      return { pageId, blockIds };
    },
    { title: SCRATCH_TITLE, count: CASES.length },
  );
  const { pageId } = created;
  const blockOf = (c: Case): string => created.blockIds[CASES.indexOf(c)]!;
  console.log(`scratch page: ${pageId}`);

  async function destroyScratchPage(): Promise<void> {
    const status = await page.evaluate(async (id: string): Promise<number> => {
      const res = await fetch(`/api/blocks/${id}`, { method: "DELETE" });
      return res.status;
    }, pageId);
    console.log(`\nscratch page deleted (HTTP ${status})`);
  }

  try {
    // The title can match more than one sidebar row (tree + favorites); the page
    // tree entry is the last. Clicking the wrong one silently doesn't navigate.
    await page.locator(`text=${SCRATCH_TITLE}`).last().click();
    await page.waitForURL(`**/pages/page/${pageId}`);
    await blockEl(page, blockOf("G")).waitFor({ state: "visible" });

    // ---- A: link + menu at once; Cmd+Z takes the paste back ------------------
    console.log("\n=== A: empty block — link and menu at once, Cmd+Z undoes");
    const a = blockEl(page, blockOf("A"));
    await focusEnd(page, a);
    await pasteUrl(page, a, URL);
    const aOpen = await menuOpen(page);
    const aLink = await linkOf(a);
    r.ok("A: the menu is open", aOpen);
    r.eq("A: the URL is already a link", aLink, { href: URL, text: URL });
    r.eq("A: rows (empty block, server-synced)", await rowLabels(page), [
      "Keep as link",
      "Mention",
      "Create bookmark",
      "Create embed",
    ]);
    if (!aOpen || aLink === null) await snap(page, OUT, "a-no-link-or-menu");

    await page.keyboard.press(UNDO);
    await page.waitForTimeout(600);
    r.eq("A: Cmd+Z closed the menu", await menuOpen(page), false);
    r.eq("A: and emptied the block", await textOf(a), "");
    r.eq("A: no link left", await linkOf(a), null);

    // ---- B: Cmd+Z takes back ONLY the paste -----------------------------------
    // No settle between the typing and the paste: the paste closes the open
    // typing run itself, and that is what this case is about.
    console.log("\n=== B: typed text survives the undo of the paste");
    const b = blockEl(page, blockOf("B"));
    await focusEnd(page, b);
    await page.keyboard.type("hello ");
    await pasteUrl(page, b, URL);
    r.ok("B: the menu is open", await menuOpen(page));
    r.eq("B: text + link", await textOf(b), `hello ${URL}`);
    // The block held text before the paste, so it is not a bookmark/embed
    // candidate.
    r.eq("B: rows (non-empty block)", await rowLabels(page), [
      "Keep as link",
      "Mention",
    ]);

    await page.keyboard.press(UNDO);
    await page.waitForTimeout(600);
    r.eq("B: Cmd+Z closed the menu", await menuOpen(page), false);
    const bText = await textOf(b);
    r.eq("B: the typed text is still there", bText, "hello");
    r.eq("B: the link is gone", await linkOf(b), null);
    if (bText !== "hello") await snap(page, OUT, "b-undo-took-typing");

    // ---- C: typing after the paste closes the menu, keeps the link -----------
    console.log("\n=== C: typing closes the menu");
    const c = blockEl(page, blockOf("C"));
    await focusEnd(page, c);
    await pasteUrl(page, c, URL);
    r.ok("C: the menu is open", await menuOpen(page));
    await page.keyboard.type("x");
    await page.waitForTimeout(400);
    r.eq("C: typing closed the menu", await menuOpen(page), false);
    // The caret sits AFTER the link, and a link refuses text at its end
    // (`canInsertTextAfter` is false), so the typed char is outside it.
    r.eq("C: the link is intact", await linkOf(c), { href: URL, text: URL });
    r.eq("C: the typed char follows it", await textOf(c), `${URL}x`);

    // ---- D: mid-sentence ------------------------------------------------------
    console.log("\n=== D: a URL pasted mid-sentence becomes a link");
    const d = blockEl(page, blockOf("D"));
    await focusEnd(page, d);
    await page.keyboard.type("before after");
    for (let i = 0; i < "after".length; i++)
      await page.keyboard.press("ArrowLeft");
    await pasteUrl(page, d, URL);
    r.eq("D: a link in the middle", await linkOf(d), { href: URL, text: URL });
    r.eq("D: the sentence around it", await textOf(d), `before ${URL}after`);
    r.eq("D: rows (non-empty block)", await rowLabels(page), [
      "Keep as link",
      "Mention",
    ]);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    r.eq("D: Esc closed the menu", await menuOpen(page), false);

    // ---- E: Mention ------------------------------------------------------------
    console.log("\n=== E: Mention retitles the link");
    const e = blockEl(page, blockOf("E"));
    await focusEnd(page, e);
    await pasteUrl(page, e, MENTION_URL);
    r.ok("E: picked Mention", await commitRow(page, "Mention"));
    r.eq("E: the menu closed", await menuOpen(page), false);
    // The title arrives after a server round-trip to example.com.
    const titled = await waitFor(
      () => linkOf(e),
      (link) => link?.text === MENTION_TITLE,
      { timeoutMs: 20_000 },
    );
    r.eq(
      `E: the link reads the page title (after ${titled.waitedMs} ms)`,
      titled.value,
      { href: MENTION_URL, text: MENTION_TITLE },
    );
    if (!titled.ok) await snap(page, OUT, "e-no-title");

    await page.keyboard.press(UNDO);
    await page.waitForTimeout(600);
    r.eq("E: Cmd+Z brings the URL text back", await linkOf(e), {
      href: MENTION_URL,
      text: MENTION_URL,
    });

    // ---- F / G: Bookmark and Embed still convert --------------------------------
    for (const [which, label, wantType] of [
      ["F", "Create bookmark", "bookmark"],
      ["G", "Create embed", "embed"],
    ] as const) {
      console.log(`\n=== ${which}: ${label}`);
      const block = blockEl(page, blockOf(which));
      await focusEnd(page, block);
      await pasteUrl(page, block, URL);
      r.ok(`${which}: picked ${label}`, await commitRow(page, label));
      const converted = await waitFor(
        async () =>
          (await fetchRows(page, pageId)).find(
            (row) => row.id === blockOf(which),
          )?.type,
        (type) => type === wantType,
        { timeoutMs: 10_000 },
      );
      r.eq(`${which}: the block's row type`, converted.value, wantType);
      if (!converted.ok) await snap(page, OUT, `${which}-not-converted`);
    }

    await snap(page, OUT, "final");
  } finally {
    await destroyScratchPage();
  }

  await r.finish();
});
