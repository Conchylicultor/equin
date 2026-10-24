import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { runClaudePrint } from "@plugins/infra/plugins/claude-cli/server";
import {
  liveBlocks,
  PAGE_BLOCK_TYPE,
  pageData,
  setPageIcon,
} from "@plugins/page/plugins/editor/server";
import { textOf } from "@plugins/page/plugins/editor/core";
import { pageBlocksAutoIcon } from "@plugins/apps/plugins/pages/plugins/auto-icon/server";
import {
  buildIconPrompt,
  PAGE_CONTENT_CHARS,
  SYSTEM_PROMPT,
} from "./icon-prompt";
import { parseIconAnswer } from "./parse-icon-answer";
import type { Emoji } from "@plugins/ui/plugins/icons/plugins/emoji/core";

// Below this much body text, an untitled page has nothing to pick an icon from:
// it is skipped WITHOUT a provenance row, so a later edit tries again.
const MIN_BODY_CHARS = 20;
const PLACEHOLDER_TITLES = new Set(["", "Untitled"]);

export type GenerateIconResult =
  | { kind: "written"; emoji: Emoji }
  | { kind: "skipped"; reason: string }
  | { kind: "rejected"; reason: string };

/**
 * Picks one page's emoji icon with Haiku and writes it back. Shared by the
 * edit-triggered job and the Regenerate endpoint, which awaits it in-request so
 * the button's pending state is exactly the pick's lifetime.
 *
 * Unforced, it is once-only: a `page_blocks_ext_auto_icon` row means generation
 * has run, and it returns on it — which also ends the loop our own icon write
 * starts (it re-emits `blocksChanged`). `force` (Regenerate) runs regardless and
 * overwrites the current icon; otherwise the write is `onlyIfUnset`, judged under
 * the page's lock, so an icon the user picked meanwhile is never replaced.
 */
export async function generatePageIcon(
  pageId: string,
  { force = false }: { force?: boolean } = {},
): Promise<GenerateIconResult> {
  const [page] = await db
    .select({ data: liveBlocks.data, pageId: liveBlocks.pageId })
    .from(liveBlocks)
    .where(and(eq(liveBlocks.id, pageId), eq(liveBlocks.type, PAGE_BLOCK_TYPE)))
    .limit(1);
  if (!page) return { kind: "skipped", reason: "not a live page" };
  if (!force && (await pageBlocksAutoIcon.get(pageId))) {
    return { kind: "skipped", reason: "already generated" };
  }

  const data = pageData(page);
  const title = data.title.trim();
  const content = await pageText(pageId);
  if (
    !force &&
    PLACEHOLDER_TITLES.has(title) &&
    content.length < MIN_BODY_CHARS
  ) {
    return { kind: "skipped", reason: "too little content" };
  }

  // Siblings as the sidebar shows them: pages sharing this page's nearest page
  // ancestor (`page_id`), wherever inside it they sit — a sub-page under a
  // toggle or an indented block has a different `parent_id` from one at the top
  // level of the same page. The parent page's icon and the page's own child
  // pages' icons are avoided too, so no row repeats the one right above or
  // below it in the tree.
  const avoid = new Set([
    ...(await siblingIcons(pageId, page.pageId)),
    ...(await childIcons(pageId)),
  ]);
  if (page.pageId !== null) {
    const parentIcon = await pageIconOf(page.pageId);
    if (parentIcon) avoid.add(parentIcon);
  }
  // A regenerate should come back with something new.
  if (force && data.icon) avoid.add(data.icon);

  const out = await runClaudePrint({
    tier: "haiku",
    prompt: buildIconPrompt({
      title: title || "Untitled",
      content,
      avoid: [...avoid],
    }),
    system: SYSTEM_PROMPT,
    timeoutMs: 30_000,
    source: { name: "page-auto-icon", context: { pageId } },
  });
  const answer = parseIconAnswer(out, avoid);
  if (!answer.ok) return { kind: "rejected", reason: answer.reason };

  await setPageIcon(pageId, answer.emoji, { onlyIfUnset: !force });
  await pageBlocksAutoIcon.upsert(pageId, {
    emoji: answer.emoji,
    generatedAt: new Date(),
  });
  return { kind: "written", emoji: answer.emoji };
}

// The page's body text as the search index derives it (every live block whose
// nearest page is this one, `textOf` each), in sibling order, capped.
async function pageText(pageId: string): Promise<string> {
  const blocks = await db
    .select({ type: liveBlocks.type, data: liveBlocks.data })
    .from(liveBlocks)
    .where(eq(liveBlocks.pageId, pageId))
    .orderBy(asc(liveBlocks.parentId), asc(liveBlocks.rank));
  return blocks
    .map((b) => textOf(b))
    .filter((t) => t.length > 0)
    .join("\n")
    .slice(0, PAGE_CONTENT_CHARS)
    .trim();
}

// The icons of the page's live sibling pages (same nearest page ancestor; the
// root pages for a top-level one), so the answer can avoid a collision.
async function siblingIcons(
  pageId: string,
  parentPageId: string | null,
): Promise<string[]> {
  const rows = await db
    .select({ data: liveBlocks.data })
    .from(liveBlocks)
    .where(
      and(
        eq(liveBlocks.type, PAGE_BLOCK_TYPE),
        parentPageId === null
          ? isNull(liveBlocks.pageId)
          : eq(liveBlocks.pageId, parentPageId),
        ne(liveBlocks.id, pageId),
      ),
    );
  const icons = new Set<string>();
  for (const row of rows) {
    const icon = pageData(row).icon;
    if (icon) icons.add(icon);
  }
  return [...icons];
}

async function pageIconOf(pageId: string): Promise<Emoji | null> {
  const [row] = await db
    .select({ data: liveBlocks.data })
    .from(liveBlocks)
    .where(and(eq(liveBlocks.id, pageId), eq(liveBlocks.type, PAGE_BLOCK_TYPE)))
    .limit(1);
  return row ? pageData(row).icon : null;
}

// The icons of the page's own live child pages (those whose nearest page
// ancestor is this page).
async function childIcons(pageId: string): Promise<string[]> {
  const rows = await db
    .select({ data: liveBlocks.data })
    .from(liveBlocks)
    .where(
      and(eq(liveBlocks.type, PAGE_BLOCK_TYPE), eq(liveBlocks.pageId, pageId)),
    );
  return rows.flatMap((row) => {
    const icon = pageData(row).icon;
    return icon ? [icon] : [];
  });
}
