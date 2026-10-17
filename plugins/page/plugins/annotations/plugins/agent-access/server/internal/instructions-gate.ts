import { db, type DbExecutor } from "@plugins/database/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  deliveredInstructionIds,
  forgetInstructionsDeliveries,
  globalInstructions,
  instructionsByIds,
  instructionsInScope,
  markInstructionsDelivered,
  renderForDelivery,
  renderInstructions,
  type RenderedInstructions,
} from "@plugins/page/plugins/annotations/plugins/instructions/server";

/**
 * How the page tools hand an agent the instructions that cover a page
 * (`research/2026-09-17-page-agent-instructions.md` §4–5).
 *
 * The `instructions` plugin answers WHICH instructions cover a page and which of
 * them a conversation has not received at their current hash. This module is
 * the agent-facing half: how they are worded, when they count as received, and
 * the rule that a write under a page waits until they have been.
 *
 * Three moments deliver them, and each marks what it handed over:
 *
 * - **A read** puts the undelivered ones in a `<received-instructions>` block
 *   ahead of the page ({@link deliverWithRead}). An instructions block the read
 *   already shows whole is not repeated there — the read itself delivers it.
 * - **A write** under a page with undelivered instructions is refused before it
 *   plans anything, and the refusal carries them ({@link assertInstructionsReceived}).
 *   The refusal is the delivery, so the retry goes through.
 * - **Conversation start** carries the GLOBAL ones ({@link renderGlobalSection}):
 *   cards in full, pages as pointers to read.
 *
 * A compaction takes back what a read or a refusal handed over: the summary
 * folds the tool result carrying them away, while the record still says
 * "received". {@link restoreAfterCompaction} hands them over again.
 */

/** An attribute value, escaped for the pseudo-XML the tools emit. */
function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/** One instructions block, with where it comes from, in full. */
function formatBlock(block: RenderedInstructions): string {
  const kind = block.form === "page" ? "page" : "card";
  const title =
    block.form === "page" && block.title !== null
      ? ` title="${attr(block.title)}"`
      : "";
  const body = block.markdown.replace(/\n+$/, "");
  return (
    `<instructions-from id="${block.id}" form="${kind}"${title} ` +
    `covers-page-id="${block.covers.pageId}" covers-page-title="${attr(block.covers.title)}">\n` +
    `${body}\n` +
    `</instructions-from>`
  );
}

/**
 * One instructions block handed back after a compaction. Like {@link formatBlock}
 * without `covers-*`: an instructions page reached through a link covered the
 * link's page, which only the read that reached it knew — the summary carries
 * where the agent was working.
 */
function formatRestoredBlock(block: RenderedInstructions): string {
  const kind = block.form === "page" ? "page" : "card";
  const title =
    block.form === "page" && block.title !== null
      ? ` title="${attr(block.title)}"`
      : "";
  const body = block.markdown.replace(/\n+$/, "");
  return (
    `<instructions-from id="${block.id}" form="${kind}"${title}>\n` +
    `${body}\n` +
    `</instructions-from>`
  );
}

/**
 * The `<received-instructions>` block: the instructions an agent has just been
 * handed, each with the page it covers. `""` when there are none, so a read
 * with nothing new is exactly the page.
 */
export function formatReceivedInstructions(
  blocks: readonly RenderedInstructions[],
): string {
  if (blocks.length === 0) return "";
  return (
    `<received-instructions>\n` +
    `The page's author left instructions for agents working in this part of the ` +
    `wiki, and this conversation had not received them yet (or they changed since ` +
    `it did). Each one applies to the page it covers and every page below it. ` +
    `Follow them. They are not part of any page's content: do not copy them into ` +
    `an edit.\n\n` +
    blocks.map(formatBlock).join("\n\n") +
    `\n</received-instructions>`
  );
}

/**
 * Whether a read already shows `block` WHOLE, so that the read itself delivers
 * it and the preamble need not repeat it.
 *
 * - A read rooted AT the block shows exactly its rendering (both are
 *   `readBlockAsMarkdown` of that id, through the same redaction).
 * - An instructions page shows up in any other read only as a pointer, never its
 *   content.
 * - A card shows up in a read of something that holds it as its tagged element:
 *   its id attribute AND its rendered content, byte for byte. Content alone is
 *   not enough (the same words may sit elsewhere), and the id alone is not
 *   either (a read rooted inside the card shows part of it).
 */
export function shownWholeByRead(
  block: RenderedInstructions,
  readRootId: string,
  body: string,
): boolean {
  if (block.id === readRootId) return true;
  if (block.form === "page") return false;
  return body.includes(`id="${block.id}"`) && body.includes(block.markdown);
}

/**
 * `read_page`'s delivery: the preamble to put ahead of the page body (`""` when
 * nothing is new), with everything the reader now has recorded as received —
 * the preamble's blocks, and the ones the body already shows whole.
 *
 * `body` is the read's own markdown and `readRootId` the id it was rooted at;
 * `pageId` is the page that id sits in, whose instructions apply.
 */
export async function deliverWithRead(args: {
  conversationId: string;
  pageId: string;
  readRootId: string;
  body: string;
  executor?: DbExecutor;
}): Promise<string> {
  const executor = args.executor ?? db;
  const refs = await instructionsInScope(args.pageId, executor);
  if (refs.length === 0) return "";
  const delivery = await renderForDelivery(args.conversationId, refs, executor);
  const shown = delivery.pending.filter((b) =>
    shownWholeByRead(b, args.readRootId, args.body),
  );
  const preamble = delivery.pending.filter((b) => !shown.includes(b));
  // Everything pending was handed over by this response, one way or the other.
  await delivery.markDelivered();
  return formatReceivedInstructions(preamble);
}

/**
 * The write rule: refuse a write under `pageId` while any instructions covering
 * it are undelivered to this conversation, or were edited since they were.
 *
 * Runs BEFORE the write plans anything, so a refusal has written nothing. The
 * refusal (409) carries the instructions in full and records them as received —
 * the refusal is the delivery — so the same call retried then goes through.
 */
export async function assertInstructionsReceived(args: {
  tool: string;
  conversationId: string;
  pageId: string;
  executor?: DbExecutor;
}): Promise<void> {
  const executor = args.executor ?? db;
  const refs = await instructionsInScope(args.pageId, executor);
  if (refs.length === 0) return;
  const delivery = await renderForDelivery(args.conversationId, refs, executor);
  if (delivery.pending.length === 0) return;
  await delivery.markDelivered();
  const n = delivery.pending.length;
  throw new HttpError(
    409,
    `${args.tool}: refused, and nothing was written. Page ${args.pageId} is ` +
      `covered by ${n === 1 ? "instructions" : `${n} sets of instructions`} from ` +
      `its author that this conversation had not received yet (or that changed ` +
      `since it did). They are below, and they now count as received. Read them, ` +
      `and retry the call if it still follows them.\n\n` +
      formatReceivedInstructions(delivery.pending),
  );
}

/**
 * The page section of the MCP server instructions an agent receives when its
 * conversation connects: what page instructions are, then every GLOBAL one —
 * cards in full, pages as pointers to read. The cards it shows are recorded as
 * received by the conversation.
 *
 * Never `null`: the fixed paragraph is worth sending even with no global
 * instructions, because instructions scoped to a page still refuse a write, and
 * an agent that knows why reads before it writes.
 *
 * Pages go as pointers rather than in full because a client may truncate long
 * server instructions; a page is the form meant for long instructions.
 */
export async function renderGlobalSection(
  conversationId: string,
  executor: DbExecutor = db,
): Promise<string> {
  const globals = await globalInstructions(executor);
  const cards = await renderInstructions(
    globals.filter((g) => g.form === "card"),
    executor,
  );
  const pages = globals.filter((g) => g.form === "page");
  await markInstructionsDelivered(conversationId, cards, executor);

  const parts = [
    `## Page instructions\n\n` +
      `Singularity pages can carry instructions from their author, the way a ` +
      `CLAUDE.md file carries instructions for a folder. They cover the page they ` +
      `sit on (an instructions page covers its parent page) and every page below ` +
      `it. read_page hands you the ones covering what you read, in a ` +
      `<received-instructions> block ahead of the page. edit_page and ` +
      `write_agent_note refuse to write under a page whose instructions you have ` +
      `not received yet, or that changed since you did; the refusal carries them, ` +
      `so read them and retry.`,
  ];
  if (cards.length > 0 || pages.length > 0) {
    parts.push(
      `These instructions are global: they apply to every conversation, ` +
        `wherever it works.`,
    );
  }
  if (cards.length > 0) {
    parts.push(
      `<global-instructions>\n${cards.map(formatBlock).join("\n\n")}\n</global-instructions>`,
    );
  }
  for (const page of pages) {
    parts.push(
      `<instructions-page id="${page.id}" title="${attr(page.title ?? "")}"/>\n` +
        `Read this page (read_page with its id) before working under ` +
        `"${page.covers.title}".`,
    );
  }
  return parts.join("\n\n");
}

/**
 * The compaction-context contribution: everything the conversation had received
 * through a read or a refusal, handed back — `""` when there is nothing.
 *
 * The compaction took them out of the agent's context, so their deliveries stop
 * counting: forgotten, then each one still live (and not withheld) is rendered
 * at its CURRENT version and recorded as received again, because this text is
 * now how the agent holds it. One transaction, so a read racing the compaction
 * never sees them half-forgotten.
 *
 * Global CARDS are left alone: they ride the MCP server instructions, which are
 * part of the system prompt and survive a compaction. (An edit to one since the
 * conversation connected was handed over by a later read or refusal, and is
 * lost with it — the rare case this leaves.)
 */
export async function restoreAfterCompaction(
  conversationId: string,
  executor: DbExecutor = db,
): Promise<string> {
  return executor.transaction(async (tx) => {
    const ids = await deliveredInstructionIds(conversationId, tx);
    const live = await instructionsByIds(ids, tx);
    const inSystemPrompt = new Set(
      live.filter((b) => b.global && b.form === "card").map((b) => b.id),
    );
    await forgetInstructionsDeliveries(
      conversationId,
      ids.filter((id) => !inSystemPrompt.has(id)),
      tx,
    );
    const rendered = await renderInstructions(
      live.filter((b) => !inSystemPrompt.has(b.id)),
      tx,
    );
    await markInstructionsDelivered(conversationId, rendered, tx);
    if (rendered.length === 0) return "";
    return (
      `<received-instructions>\n` +
      `Your context was just compacted. Before that, page authors had handed ` +
      `you the instructions below (they cover the pages you were reading or ` +
      `writing, and every page below them), and the summary does not carry ` +
      `them. They are shown as they read now. Keep following them. They are not ` +
      `part of any page's content: do not copy them into an edit.\n\n` +
      rendered.map(formatRestoredBlock).join("\n\n") +
      `\n</received-instructions>`
    );
  });
}
