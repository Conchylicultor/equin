import { db, type DbExecutor } from "@plugins/database/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  deliveredInstructionIds,
  forgetInstructionsDeliveries,
  globalInstructions,
  instructionsByIds,
  instructionsInScope,
  instructionsQuietSeconds,
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
 * - **A write** under a page with instructions it never received is refused
 *   before it plans anything, and the refusal carries them ({@link admitWrite}).
 *   The refusal is the delivery, so the retry goes through. Instructions it
 *   received and that were edited since do not refuse: the write goes through
 *   and its result carries the new version.
 * - **Every spawn** of the agent's process (launch, resume) carries the GLOBAL
 *   ones in its system prompt ({@link renderGlobalSection}): cards in full,
 *   pages as pointers to read.
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
  /** `null` for a session equin did not launch: with no conversation to
   * record them against, every instructions block covering the page is handed
   * over on every read. */
  conversationId: string | null;
  pageId: string;
  readRootId: string;
  body: string;
  executor?: DbExecutor;
}): Promise<string> {
  const executor = args.executor ?? db;
  const refs = await instructionsInScope(args.pageId, executor);
  if (refs.length === 0) return "";
  if (args.conversationId === null) {
    const rendered = await renderInstructions(refs, executor);
    return formatReceivedInstructions(
      rendered.filter((b) => !shownWholeByRead(b, args.readRootId, args.body)),
    );
  }
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
 * What a write admitted by {@link admitWrite} still owes the agent: the
 * instructions it had received and that were edited since, to hand back WITH
 * the write's result. `null` when there is nothing.
 */
export interface InstructionsUpdate {
  /** The text to append to the write's result (its own text part). */
  text: string;
  /**
   * Record the edited instructions as received at the version in {@link text}.
   * Call it once the write succeeded and its result carries the text — a write
   * that fails after the gate hands nothing over, so the next call still owes it.
   */
  markDelivered(): Promise<void>;
}

/** The `<updated-instructions>` block a successful write carries. */
function formatUpdatedInstructions(
  blocks: readonly RenderedInstructions[],
): string {
  return (
    `<updated-instructions>\n` +
    `The page's author edited instructions this conversation had already ` +
    `received (they may still be typing). Your write went through. Below is how ` +
    `they read now: follow them from here, and if what you just wrote no longer ` +
    `does, fix it with another edit. They are not part of any page's content: ` +
    `do not copy them into an edit.\n\n` +
    blocks.map(formatBlock).join("\n\n") +
    `\n</updated-instructions>`
  );
}

/**
 * How long instructions an agent already received must go without an edit
 * before their new version is handed over with a write. Below it the author is
 * taken to be still typing: handing over each keystroke's version would bury
 * the agent's writes under half-written instructions.
 */
export const INSTRUCTIONS_SETTLE_SECONDS = 10;

/**
 * The write rule, run BEFORE the write plans anything:
 *
 * - **Instructions the conversation never received** refuse the write (409),
 *   so nothing is written before the agent has read them. The refusal carries
 *   them in full — with any edited ones — and records them as received: the
 *   refusal is the delivery, so the same call retried then goes through.
 * - **Instructions it received, edited since**, do NOT refuse. The agent already
 *   works by a version of them, and the author may be editing them right now:
 *   refusing on every change would refuse every retry while they type. The
 *   write goes through and hands the current version back with its result —
 *   the returned {@link InstructionsUpdate} — once they have settled
 *   ({@link INSTRUCTIONS_SETTLE_SECONDS} without an edit). Until then the
 *   write carries nothing, and the first write after they settle carries them.
 *
 * So one write is refused at most once per instructions block per conversation
 * (again only after a compaction forgets it).
 */
export async function admitWrite(args: {
  tool: string;
  conversationId: string;
  pageId: string;
  executor?: DbExecutor;
  /** Override of {@link INSTRUCTIONS_SETTLE_SECONDS}, for tests. */
  settleSeconds?: number;
}): Promise<InstructionsUpdate | null> {
  const executor = args.executor ?? db;
  const refs = await instructionsInScope(args.pageId, executor);
  if (refs.length === 0) return null;
  const delivery = await renderForDelivery(args.conversationId, refs, executor);
  if (delivery.pending.length === 0) return null;
  if (delivery.changed.length === delivery.pending.length) {
    // Only instructions that have SETTLED are handed over: one the author is
    // still typing in would arrive as a new half-written version on every
    // write. It stays pending, and the first write after it settles carries it.
    const quiet = await instructionsQuietSeconds(
      delivery.changed.map((b) => b.id),
      executor,
    );
    const settleSeconds = args.settleSeconds ?? INSTRUCTIONS_SETTLE_SECONDS;
    const settled = delivery.changed.filter(
      (b) => (quiet.get(b.id) ?? Infinity) >= settleSeconds,
    );
    if (settled.length === 0) return null;
    return {
      text: formatUpdatedInstructions(settled),
      markDelivered: () =>
        markInstructionsDelivered(args.conversationId, settled, executor),
    };
  }
  await delivery.markDelivered();
  const n = delivery.pending.length;
  throw new HttpError(
    409,
    `${args.tool}: refused, and nothing was written. Page ${args.pageId} is ` +
      `covered by ${n === 1 ? "instructions" : `${n} sets of instructions`} from ` +
      `its author that this conversation had not received yet. They are below, ` +
      `and they now count as received. Read them, and retry the call if it ` +
      `still follows them.\n\n` +
      formatReceivedInstructions(delivery.pending),
  );
}

/**
 * The page section of the agent's system prompt, rendered at every spawn of its
 * process (launch and resume): what page instructions are, then every GLOBAL
 * one — cards in full, pages as pointers to read. The cards it shows are
 * recorded as received by the conversation: the spawn that carries them follows
 * at once, and each later spawn renders (and records) their current version.
 *
 * Never `null`: the fixed paragraph is worth sending even with no global
 * instructions, because instructions scoped to a page still refuse a write, and
 * an agent that knows why reads before it writes.
 *
 * Pages go as pointers rather than in full: a page is the form meant for long
 * instructions, and the system prompt is paid on every turn.
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
      `equin pages can carry instructions from their author, the way a ` +
      `CLAUDE.md file carries instructions for a folder. They cover the page they ` +
      `sit on (an instructions page covers its parent page) and every page below ` +
      `it. read_page hands you the ones covering what you read, in a ` +
      `<received-instructions> block ahead of the page. edit_page and ` +
      `write_agent_note refuse to write under a page whose instructions you have ` +
      `not received yet; the refusal carries them, so read them and retry. When ` +
      `instructions you received are edited since, the write goes through and ` +
      `its result carries their new version in an <updated-instructions> part.`,
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
 * Global CARDS are left alone: they ride the system prompt, which survives a
 * compaction. (An edit to one since the process spawned was handed over by a
 * later read or refusal, and is lost with it — the rare case this leaves.)
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
