import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import { readBlockAsMarkdown } from "@plugins/page/plugins/markdown-apply/server";
import { humanAudienceTypes } from "@plugins/page/plugins/annotations/server";
import type { InstructionsRef } from "./scope";
import { _pageInstructionsDeliveries } from "./tables";
import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";

/** An instructions block, rendered as the markdown an agent receives. */
export interface RenderedInstructions extends InstructionsRef {
  /**
   * The block's content as agent-facing markdown: a card's children, or an
   * instructions page's whole document (its `# Title` banner, then its content).
   * Human-audience subtrees inside it are redacted, exactly as `read_page`
   * redacts them.
   */
  markdown: string;
  /**
   * `sha256` of {@link markdown}, hex. What a delivery is recorded AT: an edit
   * to the instructions changes it, and the old delivery stops counting.
   */
  contentHash: string;
}

/** What {@link renderForDelivery} answers for one conversation. */
export interface InstructionsDelivery {
  /** Every block it was handed, rendered, in the order it was handed them. */
  rendered: RenderedInstructions[];
  /**
   * The subset this conversation has NOT received at its current hash — never
   * delivered, or delivered before its last edit. Same order.
   */
  pending: RenderedInstructions[];
  /**
   * Record every `pending` block as delivered to the conversation at the hash
   * rendered here. Call it once the agent has actually been handed them — after
   * the tool response carrying them is built, or as part of the refusal that
   * carries them.
   */
  markDelivered(): Promise<void>;
}

/** Drop every row withheld from agents, taking its subtree with it. */
function redactHumanAudience<R extends { type: string }>(rows: R[]): R[] {
  const human = humanAudienceTypes();
  return rows.filter((r) => !human.has(r.type));
}

/** Hex `sha256` of a rendered block — the {@link RenderedInstructions.contentHash}. */
export function instructionsContentHash(markdown: string): string {
  return sha256Hex(markdown);
}

/**
 * Serialize each block to the markdown an agent receives, and hash it.
 *
 * A card renders as its CONTENT (the walk rooted at the card, which is what the
 * card holds), an instructions page as its whole page read — the same document
 * `read_page` returns for it, banner included. Both are redacted through the
 * annotation family's audience predicate, so a `/private` card inside
 * instructions never reaches an agent through them.
 */
export async function renderInstructions(
  refs: readonly InstructionsRef[],
  executor: DbExecutor = db,
): Promise<RenderedInstructions[]> {
  const out: RenderedInstructions[] = [];
  for (const ref of refs) {
    const markdown = await readBlockAsMarkdown(ref.id, {
      redact: redactHumanAudience,
      executor,
    });
    out.push({
      ...ref,
      markdown,
      contentHash: instructionsContentHash(markdown),
    });
  }
  return out;
}

/**
 * Record `blocks` as delivered to `conversationId` at the hashes given — one
 * upsert on the `(conversation_id, block_id)` key, rewriting `content_hash` and
 * `delivered_at` for a re-delivery. A no-op for an empty list.
 *
 * Exported beside {@link renderForDelivery} for the caller that delivers blocks
 * it did not get from `pending` — `read_page` counts an instructions card that is
 * already visible in the body it returns as delivered.
 *
 * A block that no longer exists (purged since it was rendered) is a loud
 * foreign-key violation, not a silent skip.
 */
export async function markInstructionsDelivered(
  conversationId: string,
  blocks: readonly Pick<RenderedInstructions, "id" | "contentHash">[],
  executor: DbExecutor = db,
): Promise<void> {
  if (blocks.length === 0) return;
  // One row per block id: a duplicate in one INSERT … ON CONFLICT DO UPDATE is a
  // Postgres error ("cannot affect row a second time"), and the LAST hash is the
  // one the caller saw last.
  const byId = new Map(blocks.map((b) => [b.id, b.contentHash] as const));
  await executor
    .insert(_pageInstructionsDeliveries)
    .values(
      [...byId].map(([blockId, contentHash]) => ({
        conversationId,
        blockId,
        contentHash,
      })),
    )
    .onConflictDoUpdate({
      target: [
        _pageInstructionsDeliveries.conversationId,
        _pageInstructionsDeliveries.blockId,
      ],
      set: {
        contentHash: sql`excluded.content_hash`,
        deliveredAt: sql`now()`,
      },
    });
}

/**
 * Which of `refs` the conversation still has to receive: render each one, hash
 * it, and compare against the conversation's stored deliveries. A block with no
 * delivery, or one recorded at a different hash (the instructions were edited
 * since), is pending.
 *
 * Nothing is recorded until the caller runs `markDelivered()`: rendering is not
 * handing over, and a tool call that fails after this read must not count as a
 * delivery.
 */
export async function renderForDelivery(
  conversationId: string,
  refs: readonly InstructionsRef[],
  executor: DbExecutor = db,
): Promise<InstructionsDelivery> {
  const rendered = await renderInstructions(refs, executor);
  if (rendered.length === 0) {
    return { rendered, pending: [], markDelivered: () => Promise.resolve() };
  }
  const stored = await executor
    .select({
      blockId: _pageInstructionsDeliveries.blockId,
      contentHash: _pageInstructionsDeliveries.contentHash,
    })
    .from(_pageInstructionsDeliveries)
    .where(
      and(
        eq(_pageInstructionsDeliveries.conversationId, conversationId),
        inArray(
          _pageInstructionsDeliveries.blockId,
          rendered.map((r) => r.id),
        ),
      ),
    );
  const deliveredAt = new Map(stored.map((s) => [s.blockId, s.contentHash]));
  const pending = rendered.filter(
    (r) => deliveredAt.get(r.id) !== r.contentHash,
  );
  return {
    rendered,
    pending,
    markDelivered: () =>
      markInstructionsDelivered(conversationId, pending, executor),
  };
}

/**
 * The ids of every instructions block `conversationId` has received, oldest
 * delivery first — whatever their hash, and whether or not they still exist as
 * instructions (the caller resolves them, e.g. through `instructionsByIds`).
 */
export async function deliveredInstructionIds(
  conversationId: string,
  executor: DbExecutor = db,
): Promise<string[]> {
  const rows = await executor
    .select({ blockId: _pageInstructionsDeliveries.blockId })
    .from(_pageInstructionsDeliveries)
    .where(eq(_pageInstructionsDeliveries.conversationId, conversationId))
    .orderBy(
      asc(_pageInstructionsDeliveries.deliveredAt),
      asc(_pageInstructionsDeliveries.blockId),
    );
  return rows.map((r) => r.blockId);
}

/**
 * Forget that `conversationId` received `blockIds`: each becomes pending again,
 * so the next read hands it over and the next write under it is refused until
 * then. For a conversation whose context no longer holds what it was handed —
 * a compaction summarized the tool results that carried them away.
 */
export async function forgetInstructionsDeliveries(
  conversationId: string,
  blockIds: readonly string[],
  executor: DbExecutor = db,
): Promise<void> {
  if (blockIds.length === 0) return;
  await executor
    .delete(_pageInstructionsDeliveries)
    .where(
      and(
        eq(_pageInstructionsDeliveries.conversationId, conversationId),
        inArray(_pageInstructionsDeliveries.blockId, [...blockIds]),
      ),
    );
}
