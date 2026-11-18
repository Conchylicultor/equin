/**
 * Opening a fresh Pages document and reading blocks out of it.
 *
 * The goto-`/pages` → click **"Blank page"** → wait-for-contenteditable flow was
 * verbatim in 14 of the 29 pre-move scripts, and the NBSP-normalising text read
 * in ~10 of them. It lives here, in the editor plugin, rather than in the shared
 * harness: `framework/tooling` must not know the Pages app's copy (the literal
 * string "Blank page"). When that landing tile is renamed, one file changes
 * instead of fourteen.
 */
import type { Locator, Page } from "playwright";
import { pathUrl } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

/**
 * Every text block's visible text root in the open document, in document
 * order: its live editor, or — for a DORMANT line, drawn as static text until
 * an edit intent wakes it — its static line (`data-block-text` marks whichever
 * is on screen). A click on either lands the caret where it falls.
 */
export const BLOCK_TEXT_SELECTOR = "[data-block-id] [data-block-text]";

export function editableBlocks(page: Page): Locator {
  return page.locator(BLOCK_TEXT_SELECTOR);
}

/** The `data-block-id` of the block containing this contenteditable. */
export async function blockIdOf(block: Locator): Promise<string> {
  const id = await block.evaluate((el) =>
    el.closest("[data-block-id]")?.getAttribute("data-block-id"),
  );
  if (!id) throw new Error("element is not inside a [data-block-id] block");
  return id;
}

/**
 * A block's rendered text, with NBSP normalised to a plain space and the edges
 * trimmed — what a human reads, and what every assertion in these scripts wants.
 */
export async function blockText(block: Locator): Promise<string> {
  return (await block.innerText()).replace(/ /g, " ").trim();
}

/**
 * Every editable block's rendered text, in document order — the whole-document
 * read the structural scripts assert on.
 *
 * Deliberately `textContent`, not `blockText`'s `innerText`: this is the reader
 * the three structural scripts (paste / duplicate / drag-reorder) each had a
 * byte-identical copy of, and their expectations are pinned against it.
 */
export function blockTexts(page: Page): Promise<string[]> {
  return page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)].map((el) =>
        (el.textContent ?? "").trim(),
      ),
    BLOCK_TEXT_SELECTOR,
  );
}

export interface CaretState {
  hasSelection: boolean;
  collapsed?: boolean;
  insideBlock?: boolean;
  anchorOffset?: number;
  anchorTextLength?: number;
}

/** Where the caret sits relative to a block — the shape the CRDT tests assert on. */
export async function caretState(block: Locator): Promise<CaretState> {
  return block.evaluate((el) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { hasSelection: false };
    return {
      hasSelection: true,
      collapsed: sel.isCollapsed,
      insideBlock: el.contains(sel.anchorNode),
      anchorOffset: sel.anchorOffset,
      anchorTextLength: sel.anchorNode?.textContent?.length ?? -1,
    };
  });
}

export interface BlankDoc {
  /** URL of the created page — hand this to a second context to test convergence. */
  pageUrl: string;
  /** The page's own block id, parsed out of the URL. */
  pageId: string;
  /** The single empty text block a blank page ships with, already focused. */
  block: Locator;
  blockId: string;
}

export interface OpenBlankPageOptions {
  /** Extra pause after the block is visible, for post-mount hydration. */
  settleMs?: number;
  timeoutMs?: number;
}

/**
 * Create a fresh blank page from the Pages landing quick-create tile and focus
 * its one empty text block.
 *
 * Resolves its own target, like `support/runs.ts` — it used to take a `base`
 * origin that every call site filled with the same module-scope value.
 */
export async function openBlankPage(
  page: Page,
  opts: OpenBlankPageOptions = {},
): Promise<BlankDoc> {
  // 60s, not 30s: this ONE budget covers three separate waits (the navigation,
  // the landing tile, and the first editable block), and 30s timed out under
  // real machine load while the app was working. A budget is a deadline for
  // declaring failure, not a delay — a healthy open costs what it costs.
  const timeout = opts.timeoutMs ?? 60_000;

  await page.goto(pathUrl("/pages"), {
    waitUntil: "domcontentloaded",
    timeout,
  });
  const tile = page.getByText("Blank page", { exact: true }).first();
  await tile.waitFor({ state: "visible", timeout });
  await tile.click();

  const block = editableBlocks(page).first();
  await block.waitFor({ state: "visible", timeout });
  const blockId = await blockIdOf(block);
  await block.click();
  if (opts.settleMs) await page.waitForTimeout(opts.settleMs);

  const pageUrl = page.url();
  return { pageUrl, pageId: pageIdFromUrl(pageUrl), block, blockId };
}

/** Last path segment of a `/pages/page/:id` URL. */
export function pageIdFromUrl(url: string): string {
  const id = new URL(url).pathname.split("/").filter(Boolean).at(-1);
  if (!id) throw new Error(`no page id in URL ${url}`);
  return id;
}
