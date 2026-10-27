// End-to-end check for the link hover card.
//
// Rest the pointer on a link in a page block and a small card opens under it:
// globe + URL, Copy, Edit. Edit turns it into a URL + Title form with Remove
// link. What only a real browser can show, and what this checks:
//
//   - hovering a link opens the card with the link's URL;
//   - the pointer can travel from the link onto the card without it closing,
//     and leaving both closes it;
//   - Copy puts the URL on the clipboard;
//   - Edit → a new URL + title rewrites the `<a>`'s href and text, and ONE
//     Cmd+Z reverts both (the edit is a single undo entry via recordDocEdit);
//   - Remove link leaves the same words as plain text.
//
// The script creates its OWN scratch page and deletes it on the way out — it
// must never type into a page a human owns.
//
// Usage:
//   ./equin run plugins/page/plugins/formatting/plugins/link/e2e/link-hover-verify.ts [--url <deploy>]
//
// Exits non-zero on the first failed assertion, after dumping a screenshot.
import {
  pageFetch,
  arg,
  boot,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out", "/tmp/link-hover-verify");

const CARD = "[data-link-hover-card]";
const CARD_URL = `${CARD} [data-link-hover-url]`;
const EDITABLE = '[contenteditable="true"]';
const UNDO = "ControlOrMeta+z";

const URL_BEFORE = "https://example.com/";
const TEXT_BEFORE = "example";
const URL_AFTER = "https://example.org/new";
const TEXT_AFTER = "Example Org";

// Longer than the card's 300 ms open delay / 200 ms close delay, with room for
// a loaded machine.
const SETTLE_MS = 700;

const r = report();

await withBrowser(async (h) => {
  const { context, page } = await h.session();
  // `networkidle` never settles — the app holds a live notifications WebSocket.
  // Timeouts are generous because this repo's builds routinely drive host load
  // past core count, and a starved headless Chromium needs tens of seconds to
  // boot the SPA.
  page.setDefaultTimeout(90_000);
  page.setDefaultNavigationTimeout(90_000);
  // Copy writes through `navigator.clipboard`; reading it back needs the grant.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(pathUrl("/")).origin,
  });

  const SCRATCH_TITLE = "zz link-hover e2e";

  await boot(page, pathUrl("/pages"), {
    marker: "text=Pages",
    timeoutMs: 90_000,
  });

  const pageId = await (async ({
    title,
    url,
    text,
  }: {
    title: string;
    url: string;
    text: string;
  }): Promise<string> => {
    const create = async (body: unknown): Promise<string> => {
      const res = await pageFetch(page, "/api/blocks", {
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
    const id = await create({
      parentId: null,
      type: "page",
      data: { title, icon: null },
    });
    // One text block holding a link mid-sentence, seeded as rich-text runs
    // (`TextRun.link`) so no toolbar gesture is needed to make it. Deleting
    // the page cascades it away.
    await create({
      parentId: id,
      type: "text",
      data: {
        text: [{ text: "see " }, { text, link: url }, { text: " here" }],
      },
    });
    return id;
  })({ title: SCRATCH_TITLE, url: URL_BEFORE, text: TEXT_BEFORE });
  console.log(`scratch page: ${pageId}`);

  async function destroyScratchPage(): Promise<void> {
    const { status } = await pageFetch(page, `/api/blocks/${pageId}`, {
      method: "DELETE",
    });
    console.log(`\nscratch page deleted (HTTP ${status})`);
  }

  const block = () => page.locator(EDITABLE).last();
  const link = () => block().locator("a");
  const cardCount = () => page.locator(CARD).count();

  /** The block's link as `{ href, text }`, or null when it holds none. */
  const readLink = async (): Promise<{ href: string; text: string } | null> => {
    if ((await link().count()) === 0) return null;
    const a = link().first();
    return {
      href: (await a.getAttribute("href")) ?? "",
      text: (await a.innerText()).trim(),
    };
  };

  const blockText = async (): Promise<string> =>
    (await block().innerText()).trim();

  /** Park the pointer far from the block, and let any open card close. */
  async function pointerAway(): Promise<void> {
    await page.mouse.move(5, 5);
    await page.waitForTimeout(SETTLE_MS);
  }

  /** Rest on the link until its card is up; false if it never opened. */
  async function hoverLink(): Promise<boolean> {
    await pointerAway();
    await link().first().hover();
    const opened = await waitFor(cardCount, (n) => n > 0, {
      timeoutMs: 5_000,
    });
    return opened.ok;
  }

  try {
    // The title can match more than one sidebar row (tree + favorites); the
    // page tree entry is the last. Clicking the wrong one silently doesn't
    // navigate.
    await page.locator(`text=${SCRATCH_TITLE}`).last().click();
    await page.waitForURL(`**/pages/page/${pageId}`);
    await page.waitForSelector(EDITABLE);
    const seeded = await waitFor(readLink, (l) => l !== null);
    r.ok(
      "seeded block renders a link",
      seeded.ok && seeded.value?.href === URL_BEFORE,
      JSON.stringify(seeded.value),
    );

    // --- hover opens the card with the URL -----------------------------------
    console.log("\n=== hover opens the card");
    const opened = await hoverLink();
    r.ok("resting on the link opens the card", opened);
    if (!opened) await snap(page, OUT, "no-card");
    const shownUrl = (await page.locator(CARD_URL).innerText()).trim();
    r.eq("the card shows the link's URL", shownUrl, URL_BEFORE);
    r.eq(
      "the card starts in view mode",
      await page.locator(CARD).getAttribute("data-link-hover-card"),
      "view",
    );
    await snap(page, OUT, "1-card-view");

    // --- travelling onto the card keeps it open ------------------------------
    console.log("\n=== pointer travels from the link onto the card");
    const box = await page.locator(CARD).boundingBox();
    const linkBox = await link().first().boundingBox();
    if (box === null || linkBox === null)
      throw new Error("card or link has no bounding box");
    // Straight DOWN from the link onto the card, the way a hand travels: the
    // card opens under the link's start, so this crosses only the gap. Two
    // steps, so the pointer really crosses it rather than teleporting — but no
    // more: each step is a CDP round-trip, ~200 ms apiece on a loaded host, and
    // a long diagonal sweep over the text beside the link would outlast the
    // close grace for reasons that have nothing to do with the card.
    const x = linkBox.x + Math.min(linkBox.width, box.width) / 2;
    await page.mouse.move(x, box.y + box.height / 2, { steps: 2 });
    await page.waitForTimeout(SETTLE_MS);
    r.ok("the card stays open with the pointer on it", (await cardCount()) > 0);

    await pointerAway();
    r.ok(
      "leaving both the link and the card closes it",
      (await waitFor(cardCount, (n) => n === 0, { timeoutMs: 5_000 })).ok,
    );

    // --- Copy ----------------------------------------------------------------
    console.log("\n=== Copy puts the URL on the clipboard");
    await page.evaluate(() => navigator.clipboard.writeText(""));
    r.ok("card reopens for Copy", await hoverLink());
    await page.locator(CARD).getByRole("button", { name: "Copy link" }).click();
    const copied = await waitFor(
      () => page.evaluate(() => navigator.clipboard.readText()),
      (t) => t === URL_BEFORE,
      { timeoutMs: 5_000 },
    );
    r.ok(
      "Copy wrote the URL",
      copied.ok,
      `clipboard=${JSON.stringify(copied.value)}`,
    );

    // --- Edit: new URL + title, then one Cmd+Z -------------------------------
    console.log("\n=== Edit rewrites href + text; one Cmd+Z reverts it");
    await page
      .locator(CARD)
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await page.waitForSelector(`${CARD}[data-link-hover-card="edit"]`);
    // Pointer movement must not close an open form.
    await pointerAway();
    r.ok("the edit form survives the pointer leaving", (await cardCount()) > 0);
    await snap(page, OUT, "2-card-edit");

    await page.locator(`${CARD} input[name="url"]`).fill(URL_AFTER);
    await page.locator(`${CARD} input[name="title"]`).fill(TEXT_AFTER);
    await page.locator(`${CARD} input[name="title"]`).press("Enter");
    r.ok(
      "Enter closes the card",
      (await waitFor(cardCount, (n) => n === 0)).ok,
    );

    const edited = await waitFor(
      readLink,
      (l) => l?.href === URL_AFTER && l.text === TEXT_AFTER,
      { timeoutMs: 10_000 },
    );
    r.ok(
      "Apply rewrote the link's href and text",
      edited.ok,
      JSON.stringify(edited.value),
    );
    if (!edited.ok) await snap(page, OUT, "edit-not-applied");

    // ONE press. Two presses would also land on the original, but would mean
    // the URL and the text change were recorded as separate entries.
    await page.keyboard.press(UNDO);
    const reverted = await waitFor(
      readLink,
      (l) => l?.href === URL_BEFORE && l.text === TEXT_BEFORE,
      { timeoutMs: 10_000 },
    );
    r.ok(
      "one Cmd+Z restores both the URL and the text",
      reverted.ok,
      JSON.stringify(reverted.value),
    );
    if (!reverted.ok) await snap(page, OUT, "undo-not-reverted");

    // --- Remove link ---------------------------------------------------------
    console.log("\n=== Remove link leaves plain text");
    r.ok("card reopens for Remove", await hoverLink());
    await page
      .locator(CARD)
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await page.waitForSelector(`${CARD}[data-link-hover-card="edit"]`);
    await page
      .locator(CARD)
      .getByRole("button", { name: "Remove link" })
      .click();
    r.ok(
      "Remove link closes the card",
      (await waitFor(cardCount, (n) => n === 0)).ok,
    );
    const removed = await waitFor(
      async () => ({ link: await readLink(), text: await blockText() }),
      (s) => s.link === null,
      { timeoutMs: 10_000 },
    );
    r.ok(
      "the block holds no link",
      removed.ok,
      JSON.stringify(removed.value.link),
    );
    r.eq(
      "the words stay, as plain text",
      removed.value.text,
      `see ${TEXT_BEFORE} here`,
    );

    await snap(page, OUT, "final");
  } finally {
    await destroyScratchPage();
  }

  await r.finish();
});
