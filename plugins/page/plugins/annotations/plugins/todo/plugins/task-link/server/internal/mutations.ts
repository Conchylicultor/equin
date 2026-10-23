import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  loadBlockScope,
  readBlockAsMarkdown,
} from "@plugins/page/plugins/markdown-apply/server";
import { todoBlock } from "@plugins/page/plugins/annotations/plugins/todo/core";
import { PAGES_CATEGORY_ID } from "@plugins/page/plugins/prompt/plugins/link/server";
import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import { createTask } from "@plugins/tasks/plugins/tasks-core/server";
import { scheduleTaskTitleUpdate } from "@plugins/tasks/plugins/task-title/server";
import { synthesiseTitleFallback } from "@plugins/tasks/plugins/task-title/core";
import { todoTask } from "./tables";

/**
 * How much of the card's own text the prompt inlines.
 *
 * The card is a SNAPSHOT — the page is authoritative and the agent is told to go
 * read it — so the inlined copy exists to let the agent start without a tool
 * call, not to be complete. A long card would otherwise push the instructions
 * that follow it out of the model's attention for no gain.
 */
const CARD_TEXT_CAP = 1500;

/** The card's markdown, capped, SAYING SO when it was cut. */
function cardSnapshot(markdown: string): string {
  const text = markdown.trim();
  if (text.length <= CARD_TEXT_CAP) return text;
  // Never a silent truncation: an agent that cannot tell it was handed a prefix
  // will happily conclude the card asks for less than it does.
  return `${text.slice(0, CARD_TEXT_CAP)}\n\n…truncated; read the page for the rest.`;
}

/**
 * What a card with nothing written in it yet is called. An empty card is a
 * legitimate state — `TODO ` mints one the instant it is typed — and dispatching
 * from it is still meaningful (the agent gets the page), so it gets a name
 * rather than an empty title.
 */
const EMPTY_CARD_TITLE = "Empty TODO card";

/**
 * The card's first line of text — the seed the task's title is synthesised from
 * and the text Haiku upgrades it against, or `""` for a card with no text at all.
 *
 * Deliberately NOT the composed prompt: that opens with "Work on the TODO card
 * `block-…`", so every task would be titled after its own block id. The card's
 * own first line is the one thing in this whole payload a human wrote.
 */
function titleSeed(markdown: string): string {
  return (
    markdown
      .split(/\r?\n/)
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

function composePrompt(
  blockId: string,
  pageId: string,
  cardMarkdown: string,
  context: string | undefined,
): string {
  const extra = context?.trim();
  return [
    `Work on the TODO card \`${blockId}\` in Singularity page \`${pageId}\`.`,
    "",
    "<todo>",
    cardSnapshot(cardMarkdown),
    "</todo>",
    "",
    `Read the page with read_page("${pageId}") for the surrounding context — the`,
    "card above is a snapshot and the page is authoritative. When you are done,",
    "write your findings back with edit_page as an <agent-inline> card placed at the",
    "END of that TODO card.",
    ...(extra ? ["", extra] : []),
  ].join("\n");
}

/**
 * The task this TODO card dispatches agents onto, plus the prompt to launch with.
 *
 * Idempotent, and the ONE place the one-task-per-card rule is exercised: an
 * already-linked card returns its existing task, so a second dispatch is a
 * second ATTEMPT on the same task. Nothing here mints that attempt —
 * `createConversation` with a `taskId` and no `attemptId` already does, so
 * requirement "many attempts, one task" costs no code beyond returning the same
 * id twice.
 *
 * The prompt is recomposed on EVERY call, including the reuse path, because the
 * card's contents have moved on since the first dispatch — a second agent must
 * be told what the card says now, not what it said then. It is also what the
 * task's `description` is set to on creation, so the task detail shows what the
 * first agent was actually asked.
 */
export async function ensureTodoTask(
  blockId: string,
  context: string | undefined,
): Promise<{ taskId: string; prompt: string }> {
  // Resolves the owning page AND proves the block is live — a trashed or
  // non-existent block is a 404 from here, not an empty document further down.
  const scope = await loadBlockScope(blockId);
  const row = scope.rows.find((b) => b.id === blockId);
  // `loadBlockScope` already refuses a block that is not in its page's forest,
  // and the page's own row is never in its own partition — so a page id reaches
  // here with no row, which is exactly one of the wrong types below.
  if (row?.type !== todoBlock.type) {
    throw new HttpError(
      400,
      `block ${blockId} is a "${row?.type ?? "page"}", not a "${todoBlock.type}" card — ` +
        "only a TODO card can dispatch an agent",
    );
  }

  // The card's CHILDREN as markdown (no title banner: this is not a page-rooted
  // read). The same dialect `read_page` hands the agent, so the snapshot in the
  // prompt and what it re-reads on the page are one text.
  //
  // It loads the page's rows a SECOND time, deliberately and as the MCP tools do
  // for the same reason: the question above is "may this block be dispatched at
  // all", which has to be answered before the id is handed over as a root, and
  // the engine's own read is what keeps its walk and its rows one thing.
  const cardMarkdown = await readBlockAsMarkdown(blockId);
  const prompt = composePrompt(blockId, scope.pageId, cardMarkdown, context);

  const existing = await todoTask.get(blockId);
  if (existing) return { taskId: existing.taskId, prompt };

  const seed = titleSeed(cardMarkdown);
  const fallbackTitle =
    seed === "" ? EMPTY_CARD_TITLE : synthesiseTitleFallback(seed);
  const task = await createTask({
    title: fallbackTitle,
    // Synthesised summary, upgraded by Haiku.
    titleAuto: true,
    description: prompt,
    author: "user",
  });
  scheduleTaskTitleUpdate(task.id, seed, fallbackTitle);
  // The SAME category `/prompt`-launched tasks get, from the plugin that owns
  // the one `TaskCategory({ id: "pages" })` registration. One category, one
  // registration — a second one here would be a duplicate id, not a new lane.
  await setTaskCategory(task.id, PAGES_CATEGORY_ID);
  await todoTask.upsert(blockId, { taskId: task.id });
  return { taskId: task.id, prompt };
}
