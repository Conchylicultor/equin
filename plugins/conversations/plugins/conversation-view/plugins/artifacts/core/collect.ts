import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { mergeHits } from "./merge";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import type { ArtifactHit } from "./contract";

/** What the extraction pass needs of a registered kind. */
export interface KindExtractor {
  id: string;
  /** Whether this kind's items add to the count: `made` counts only `"produced"` kinds. */
  origin: "produced" | "consumed";
  /** PURE over one event; every hit's `kind` must be `id`. */
  extract: (event: JsonlEvent) => ArtifactHit[];
}
export const ArtifactItemSchema = z.object({
  key: z.string(),
  relation: z.enum(["created", "edited", "referenced"]),
  firstAt: z.string(),
  lastAt: z.string(),
});

/**
 * What the conversation produced. The hook hands it out as a resource result
 * (`ConversationArtifactsResult`), never a count that starts at zero: an
 * artifact count is a claim about the user's work, and a button that says "0"
 * and then says "7" told them something false for as long as the transcript
 * took to arrive.
 *
 * Plain records keyed by kind id, so it crosses the wire as it is.
 */
export const ConversationArtifactSetSchema = z.object({
  /** Items per kind id. A kind that found nothing has no entry. */
  byKind: z.record(z.string(), z.array(ArtifactItemSchema)),
  /** Every artifact, across every kind — what the panel lists. */
  total: z.number().int(),
  /**
   * What the conversation MADE, per kind id: the items of `"produced"`
   * kinds it created or edited — never one it only read. A kind with
   * nothing made has no entry, so the closed button draws exactly the kinds
   * listed here, each with its number.
   */
  made: z.record(z.string(), z.number().int()),
  /**
   * The sum of `made` — the whole of what the conversation produced.
   *
   * Lower than `total` whenever the conversation looked at things it did
   * not make, and `0` for one that only looked: the panel still has
   * something to show, so the two are asked separately.
   */
  count: z.number().int(),
});
export type ConversationArtifactSet = z.infer<
  typeof ConversationArtifactSetSchema
>;

/**
 * What a conversation made, changed or looked at, over its WHOLE transcript:
 * derived on the server (every registered kind's extractor runs there), pushed
 * only when it changes.
 */
export const conversationArtifacts = liveValue(
  "conversations.conversation-view.artifacts",
  { schema: ConversationArtifactSetSchema, params: ["id"] },
);

/** Events are read in transcript order, so hits arrive oldest-first. */
export function collectArtifacts(
  kinds: readonly KindExtractor[],
  events: readonly JsonlEvent[],
): ConversationArtifactSet {
  const hits: ArtifactHit[] = [];
  for (const event of events) {
    for (const kind of kinds) {
      for (const hit of kind.extract(event)) {
        // A kind reporting under someone else's name would land its rows in a
        // section that never checked for them — silently, and only for the
        // events that hit that branch. Loud here, where the id is still in hand.
        if (hit.kind !== kind.id) {
          throw new Error(
            `[artifacts] kind "${kind.id}" emitted a hit for kind "${hit.kind}" ` +
              `(key "${hit.key}"). An extractor may only report its own kind.`,
          );
        }
        hits.push(hit);
      }
    }
  }

  const produced = new Set(
    kinds.filter((kind) => kind.origin === "produced").map((kind) => kind.id),
  );
  const merged = mergeHits(hits);
  const byKind: ConversationArtifactSet["byKind"] = {};
  const made: ConversationArtifactSet["made"] = {};
  let total = 0;
  let count = 0;
  for (const [id, items] of merged) {
    byKind[id] = items;
    total += items.length;
    if (!produced.has(id)) continue;
    // Reading a doc is not making it: only a created or edited item counts.
    const n = items.filter((item) => item.relation !== "referenced").length;
    if (n === 0) continue;
    made[id] = n;
    count += n;
  }
  return { byKind, total, made, count };
}
