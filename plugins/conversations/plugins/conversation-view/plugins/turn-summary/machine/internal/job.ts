import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { getConfig } from "@plugins/config_v2/server";
import { readConversationTurns } from "@plugins/conversations/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import {
  ClaudeCliError,
  runClaudePrint,
} from "@plugins/infra/plugins/claude-cli/server";
import { turnSummaryConfig } from "../../shared/config";
import { turnSummaries } from "../../server/internal/tables";
import { parseMarkdownSections } from "./parse";

const HAIKU_TIMEOUT_MS = 12_000;
const MAX_TURN_TEXT_CHARS = 12_000;

const SYSTEM_PROMPT = `You are summarizing the latest exchange between a user and an AI coding assistant.

Output ONLY markdown with these three sections, in this exact order, using these exact headers:

## Summary
<one short sentence — what just happened, max ~20 words>

## Caveats
- <thing the user should review, double-check, or decide on>
- <one bullet per item; 0–4 bullets; if there are none, leave the section body empty>

## Actions
- <suggested next step the user could take>
- <one bullet per item; 0–4 bullets; if there are none, leave the section body empty>

Be terse. No prose outside the sections. No code blocks.`;

function clip(s: string): string {
  if (s.length <= MAX_TURN_TEXT_CHARS) return s;
  return s.slice(0, MAX_TURN_TEXT_CHARS) + "\n…[truncated]";
}

function buildPrompt(userText: string, assistantText: string): string {
  return `### USER\n${clip(userText.trim()) || "<empty>"}\n\n### ASSISTANT\n${clip(assistantText.trim()) || "<empty>"}`;
}

// Triggered globally on every `conversationTurnCompleted` event (see
// this plugin's machine barrel). Idempotent on (conversationId, messageId): if a row
// already exists for this assistant message id, the job no-ops — handles
// re-emission after server restart.
export const generateTurnSummaryJob = defineJob({
  name: "turn-summary.generate",
  description:
    "Writes a short summary of each finished turn, with caveats to review and suggested next steps.",
  // seconds: bounded by the 12s HAIKU_TIMEOUT_MS the runClaudePrint call below
  // passes itself.
  hold: "seconds",
  input: z.object({}).passthrough(),
  event: z
    .object({
      conversationId: z.string(),
      text: z.string().optional(),
      messageId: z.string().nullable().optional(),
    })
    .passthrough(),
  dedup: "none",
  maxAttempts: 2,
  run: async ({ event }) => {
    const { enabled } = getConfig(turnSummaryConfig);
    if (!enabled) return;

    const conversationId = event?.conversationId;
    if (!conversationId) return;
    // The guard above narrowed `event`: a truthy `conversationId` cannot come
    // from an absent `event`, so neither read below needs an optional chain.
    const assistantText = event.text ?? "";
    const messageId = event.messageId ?? null;
    if (!messageId) {
      // Without a stable assistant message id we can't dedupe. Skip — the
      // next turn will retry and pick up a non-null id.
      return;
    }

    const existing = await turnSummaries.get(conversationId);
    if (existing?.messageId === messageId) return;

    const conversation = await getConversation(conversationId);
    if (!conversation) return;

    const turns = await readConversationTurns(conversationId);
    if (turns.length === 0) return;
    // Find the last user turn (typically right before the assistant turn we
    // just received). Fall back to empty string if the transcript hasn't
    // caught up yet.
    const lastUser = [...turns].reverse().find((t) => t.role === "user");
    const userText = lastUser?.text ?? "";

    let raw: string;
    try {
      raw = await runClaudePrint({
        tier: "haiku",
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(userText, assistantText),
        timeoutMs: HAIKU_TIMEOUT_MS,
        source: {
          name: "turn-summary",
          context: { conversationId, messageId },
        },
      });
    } catch (err) {
      if (err instanceof ClaudeCliError) {
        console.warn(
          `[turn-summary] Haiku call failed for ${conversationId}: ${err.message}`,
        );
        return;
      }
      throw err;
    }

    const parsed = parseMarkdownSections(raw);
    if (!parsed.summary && !parsed.caveats && !parsed.actions) return;

    await turnSummaries.upsert(conversationId, {
      messageId,
      summary: parsed.summary,
      caveats: parsed.caveats,
      actions: parsed.actions,
      generatedAt: new Date(),
    });
  },
});
