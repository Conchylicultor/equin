import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConfig } from "@plugins/config_v2/server";
import { readConversationTurns } from "@plugins/conversations/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import {
  ClaudeCliError,
  runClaudePrint,
} from "@plugins/infra/plugins/claude-cli/server";
import { conversationCategoryConfig } from "../../shared/config";
import { getCategories, type CategoryDescriptor } from "./categories";
import {
  getCategoryRows,
  upsertCategoryRows,
} from "../../server/internal/store";
import { matchItem } from "./match-item";
import {
  ClassificationParseError,
  parseClassification,
} from "./parse-classification";
import { buildSystemPrompt, buildTranscriptDigest } from "./prompt";

const HAIKU_TIMEOUT_MS = 30_000;

/**
 * Which categories this run should ask about.
 *
 * A category is skipped when it has nothing to pick from, when the caller named
 * a different set, or when it is already answered. "Already answered" is what
 * makes the job incremental: adding a new category to config classifies only
 * that category on the conversation's next turn, and the steady state costs one
 * indexed query and no `claude` process at all.
 *
 * A MANUAL assignment is only ever replaced when the user asked for that
 * specific category to be re-classified — so "Re-classify all" can never
 * silently stomp something the user set by hand.
 */
function selectTargets(
  categories: readonly CategoryDescriptor[],
  assigned: Map<string, { source: "haiku" | "manual" }>,
  requested: string[] | undefined,
  force: boolean,
): CategoryDescriptor[] {
  return categories.filter((category) => {
    if (category.items.length === 0) return false;
    if (requested && !requested.includes(category.id)) return false;
    const prior = assigned.get(category.id);
    if (!prior) return true;
    if (prior.source === "manual") return force && requested !== undefined;
    return force;
  });
}

// Triggered globally on every `conversationTurnCompleted` event and
// direct-enqueued from the re-classify HTTP route.
export const classifyConversationJob = defineJob({
  name: "conversation-category.classify",
  description:
    "Asks a small model to sort a conversation into the configured categories after each turn.",
  // seconds: bounded by the 30s HAIKU_TIMEOUT_MS the runClaudePrint call below
  // passes itself.
  hold: "seconds",
  input: z.object({
    conversationId: z.string().optional(),
    categoryIds: z.array(z.string()).optional(),
    force: z.boolean().optional(),
  }),
  event: z
    .object({
      conversationId: z.string(),
    })
    .passthrough(),
  dedup: "none",
  maxAttempts: 2,
  run: async ({ input, event }) => {
    const conversationId = input.conversationId ?? event?.conversationId;
    if (!conversationId) {
      console.warn(
        "[conversation-category] classify fired with no conversationId; skipping",
      );
      return;
    }
    const force = input.force ?? false;

    // Read config before touching the DB: with auto-classify off, an ordinary
    // turn must cost nothing at all.
    const { autoClassify } = getConfig(conversationCategoryConfig);
    if (!force && !autoClassify) return;

    const categories = getCategories();
    if (categories.length === 0) return;

    const assigned = await getCategoryRows(conversationId);
    const targets = selectTargets(
      categories,
      assigned,
      input.categoryIds,
      force,
    );
    if (targets.length === 0) return;

    const conversation = await getConversation(conversationId);
    if (!conversation) {
      // The conversation row may have been deleted between event emit and
      // job dispatch — nothing to classify.
      return;
    }

    const turns = await readConversationTurns(conversationId);
    if (turns.length === 0) {
      // Transcript not yet on disk (rare race after very-first turn); leave
      // unclassified — the next turn-completed event will retry.
      return;
    }

    let raw: string;
    try {
      raw = await runClaudePrint({
        tier: "haiku",
        system: buildSystemPrompt(targets),
        prompt: buildTranscriptDigest(turns),
        timeoutMs: HAIKU_TIMEOUT_MS,
        source: {
          name: "conversation-category",
          context: { conversationId, categoryIds: targets.map((c) => c.id) },
        },
      });
    } catch (err) {
      if (err instanceof ClaudeCliError) {
        console.warn(
          `[conversation-category] Haiku call failed for ${conversationId}: ${err.message}`,
        );
        return;
      }
      throw err;
    }

    let answer: Record<string, string>;
    try {
      answer = parseClassification(raw);
    } catch (err) {
      if (err instanceof ClassificationParseError) {
        console.warn(
          `[conversation-category] ${conversationId}: ${err.message}`,
        );
        return;
      }
      throw err;
    }

    // Each category resolves on its own: a missing key or an unmatched answer
    // costs that one category, never the whole run. Whatever resolved is
    // written; the rest is retried on the next turn.
    const resolved: { categoryId: string; item: string }[] = [];
    for (const category of targets) {
      // Models reach for the human-readable label, so accept the name as a key
      // too. `hasOwn` keeps inherited Object keys ("constructor") out.
      const reply = Object.hasOwn(answer, category.id)
        ? answer[category.id]
        : Object.hasOwn(answer, category.name)
          ? answer[category.name]
          : undefined;
      if (reply === undefined) continue;

      const match = matchItem(
        reply,
        category.items.map((i) => i.name),
      );
      if (!match.ok) {
        console.warn(
          `[conversation-category] ${conversationId} / ${category.name}: ${match.reason}`,
        );
        continue;
      }
      resolved.push({ categoryId: category.id, item: match.item });
    }

    await upsertCategoryRows(conversationId, resolved, "haiku");
  },
});
