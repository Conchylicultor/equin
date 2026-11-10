import { z } from "zod";
import { ReportKind, type ReportRow } from "@plugins/reports/server";
import { HOOK_OUTPUT_CAP } from "@plugins/conversations/plugins/compaction-context/core";

export const CompactionContextCutPayloadSchema = z.object({
  conversationId: z.string(),
  /** The length of the context the hook printed. */
  sentChars: z.number(),
  received: z.enum(["preview", "altered", "none"]),
  receivedChars: z.number(),
  /** What became of the turn carrying the whole context. */
  turn: z.enum(["submitted", "not-found", "stopped"]),
});
export type CompactionContextCutPayload = z.infer<
  typeof CompactionContextCutPayloadSchema
>;

const RECEIVED: Record<CompactionContextCutPayload["received"], string> = {
  preview:
    "the CLI's `<persisted-output>` preview (the first ~2 KB, the rest saved to a file)",
  altered: "some other text than what the hook printed",
  none: "no SessionStart context at all before it answered",
};

/**
 * The context handed back after a compaction did not reach the agent whole:
 * its transcript shows the CLI cut the hook's output. One row for the whole
 * kind — every occurrence has the same cause (what the parts that are never
 * cut add up to, against the CLI's cap) — counted per occurrence.
 */
export const compactionContextCutKind = ReportKind({
  kind: "compaction-context-cut",
  schema: CompactionContextCutPayloadSchema,
  fingerprint: () => "compaction-context-cut",
  meta: {
    tag: "[compaction]",
    notif: "An agent's compaction context was cut by the Claude CLI",
    variant: "warning",
  },
  renderTask: (row: ReportRow) => {
    const d = CompactionContextCutPayloadSchema.parse(row.data);
    return {
      title: `[compaction] Compaction context cut by the Claude CLI (${d.sentChars} chars)`,
      description: [
        `After conversation \`${d.conversationId}\` was compacted, the ` +
          `compaction-context hook printed ${d.sentChars} characters, and the ` +
          `agent's transcript shows it got ${RECEIVED[d.received]} ` +
          `(${d.receivedChars} characters).`,
        "",
        d.turn === "submitted"
          ? "The whole context was sent to the agent as a turn, so it has it now."
          : `The turn carrying the whole context was NOT delivered (${d.turn}): ` +
            "the agent is working without it, while page instructions still " +
            "count as received.",
        "",
        `**Why it can happen.** The endpoint cuts only the \`fit\` parts (the ` +
          `task tree) to its budget; the \`whole\` parts (page instructions) ` +
          `are never cut, so when they alone outgrow the CLI's cap — or the CLI ` +
          `lowered its cap below our copy, \`HOOK_OUTPUT_CAP\` = ${HOOK_OUTPUT_CAP} ` +
          `in \`conversations/compaction-context/core/budget.ts\` — the CLI cuts ` +
          `the output.`,
        "",
        `**Triage.** Compare \`sentChars\` with the cap. Well over it: which ` +
          `instructions the conversation had received ` +
          `(\`page_instructions_deliveries\`) and why they are that long. Under ` +
          `it: the CLI's threshold moved — read it in the bundled binary (the ` +
          `\`additionalContext\` threshold) and update the copy.`,
        "",
        `**Occurrences:** ${row.count}`,
        `**First seen:** ${row.firstSeenAt.toISOString()}`,
        `**Last seen:** ${row.lastSeenAt.toISOString()}`,
      ].join("\n"),
    };
  },
});
