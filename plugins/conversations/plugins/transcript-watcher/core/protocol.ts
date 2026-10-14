import { z } from "zod";
import { RequestConfigSchema } from "./request-config";

// Wire tag the agent reads in its first user turn. Named `special_instructions`
// (not `preprompt`) so the model reads it as an imperative to follow. The
// internal event kind stays `preprompt`; the UI label is "Instructions". This
// constant is the SINGLE SOURCE OF TRUTH shared by the launch injector
// (lifecycle.ts) and the transcript parser (parse-jsonl.ts) — a drift between
// the two would silently break extraction.
export const PREPROMPT_TAG = "special_instructions";

/** Wrap preprompt text for prepending to the first user turn. */
export function wrapPreprompt(text: string): string {
  return `<${PREPROMPT_TAG}>\n${text}\n</${PREPROMPT_TAG}>`;
}

/** Lift the first preprompt block out of `text`. Returns the inner text (or null) + the remainder. */
export function extractPreprompt(text: string): {
  preprompt: string | null;
  rest: string;
} {
  // Local regex (no `g` flag) — first match only; the preprompt is only ever
  // injected into the first user turn.
  const re = new RegExp(`<${PREPROMPT_TAG}>([\\s\\S]*?)</${PREPROMPT_TAG}>`);
  const m = re.exec(text);
  if (!m) return { preprompt: null, rest: text };
  const inner = m[1]!.trim();
  const rest = (
    text.slice(0, m.index) + text.slice(m.index + m[0].length)
  ).trim();
  return { preprompt: inner ? inner : null, rest };
}

export const TokenUsageSchema = z.object({
  input: z.number().int(),
  output: z.number().int(),
  cacheRead: z.number().int(),
  cacheCreation: z.number().int(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

const UserTextSegmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), value: z.string() }),
  z.object({ kind: z.literal("image"), mime: z.string(), data: z.string() }),
]);
export type UserTextSegment = z.infer<typeof UserTextSegmentSchema>;

/**
 * An answered AskUserQuestion as the CLI records it: the line's `toolUseResult`
 * (minus its echo of `questions`). This is the answer as data — `content` is
 * only the CLI's prose wording of it for the model, which changes across CLI
 * versions. `answers` is keyed by question text; a multi-select value is its
 * labels joined with ", ", and `(no option selected)` marks a question answered
 * with a note alone. `response` is free text given in place of the answers.
 */
export const QuestionAnswerSchema = z.object({
  answers: z.record(z.string(), z.string()),
  annotations: z
    .record(
      z.string(),
      z.object({
        notes: z.string().optional(),
        preview: z.string().optional(),
      }),
    )
    .optional(),
  response: z.string().optional(),
});
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

const ToolCallResultSchema = z.object({
  at: z.string(),
  content: z.string(),
  isError: z.boolean().optional(),
  /** The structured answer of an answered AskUserQuestion; absent otherwise. */
  questionAnswer: QuestionAnswerSchema.optional(),
  /**
   * Names carried by the result's `tool_reference` blocks — the content type a
   * tool-search result uses to hand deferred tool definitions to the model.
   * They hold no text, so `content` alone would read as an empty result.
   * Absent when the result has none.
   */
  toolReferences: z.array(z.string()).optional(),
});
export type ToolCallResult = z.infer<typeof ToolCallResultSchema>;

export const JsonlEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user-text"),
    at: z.string(),
    text: z.string(),
    segments: z.array(UserTextSegmentSchema).optional(),
    /**
     * The transcript line's uuid — present exactly when the row is a message
     * the user typed (`userPromptText`), which is what a rewind can cut at.
     * Absent on text that merely arrived in a user-role line (the remainder of
     * a delivered background report, a relayed message).
     */
    uuid: z.string().optional(),
  }),
  z.object({
    kind: z.literal("user-image"),
    at: z.string(),
    mime: z.string(),
    data: z.string(),
  }),
  z.object({
    kind: z.literal("tool-call"),
    at: z.string(),
    messageId: z.string().optional(),
    toolUseId: z.string(),
    name: z.string(),
    input: z.unknown(),
    usage: TokenUsageSchema.optional(),
    result: ToolCallResultSchema.optional(),
    injectedContext: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("assistant-thinking"),
    at: z.string(),
    messageId: z.string().optional(),
    thinking: z.string(),
  }),
  z.object({
    kind: z.literal("assistant-text"),
    at: z.string(),
    messageId: z.string().optional(),
    text: z.string(),
    stopReason: z.string().optional(),
    usage: TokenUsageSchema.optional(),
  }),
  z.object({
    kind: z.literal("system"),
    at: z.string(),
    subtype: z.string().optional(),
    text: z.string(),
  }),
  z.object({
    // Harness-injected prompt turns (loop/queue wakeups, "Continue from where
    // you left off.", local-command caveats). These are `type:"user"` lines
    // with `isMeta:true` — never authored by the human — so they must not
    // render as user messages.
    kind: z.literal("meta-prompt"),
    at: z.string(),
    source: z.string().optional(),
    text: z.string(),
  }),
  z.object({
    // Messages relayed from OTHER Claude sessions. The harness drops a
    // `<teammate-message>` block into a `type:"user"` turn (sometimes wrapped in
    // a JSON envelope); these are not authored by the human, so they render as a
    // distinct inbound peer-message card rather than a user bubble.
    kind: z.literal("teammate-message"),
    at: z.string(),
    teammateId: z.string().optional(),
    color: z.string().optional(),
    summary: z.string().optional(),
    body: z.string(),
  }),
  z.object({
    kind: z.literal("summary"),
    at: z.string(),
    text: z.string(),
  }),
  z.object({
    // One context compaction, folded from the run of lines Claude Code writes
    // for it: the `compact_boundary` system line (its token counts), the
    // `isCompactSummary` user line (the summary the agent continues from — not
    // something the user wrote) and the files re-read right after it.
    kind: z.literal("compaction"),
    at: z.string(),
    trigger: z.string().optional(),
    preTokens: z.number().optional(),
    postTokens: z.number().optional(),
    /** The summary as markdown, without the harness's "This session is being continued…" preamble. */
    summary: z.string().optional(),
    files: z.array(
      z.object({
        path: z.string(),
        /** Present when the file's content was re-attached, absent for a bare reference. */
        lines: z.number().optional(),
      }),
    ),
  }),
  z.object({
    kind: z.literal("preprompt"),
    at: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("task-notification"),
    at: z.string(),
    taskId: z.string(),
    toolUseId: z.string().optional(),
    status: z.string(),
    summary: z.string(),
    outputFile: z.string().optional(),
    extra: z.record(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("attachment"),
    at: z.string(),
    subtype: z.string(),
    attachment: z.unknown(),
  }),
  z.object({
    // Claude Code prompt-queue events: items enqueued, dequeued (sent to the
    // agent on its next turn), or removed without being sent. `type:
    // "queue-operation"` lines carry an `operation` discriminator and optional
    // `content` (a queued prompt, or a `<task-notification>` block from a
    // background task completion).
    kind: z.literal("queue-operation"),
    at: z.string(),
    operation: z.string(),
    content: z.string().optional(),
  }),
  z.object({
    // A Claude Code rewind checkpoint: `type: "file-history-delta"`, written
    // right before the agent first changes a file within a turn, recording the
    // file's prior state so a rewind can restore it. `created` is true when
    // the file did not exist yet (its backup is null) — a rewind deletes it.
    kind: z.literal("file-checkpoint"),
    at: z.string(),
    /** Absolute path of the checkpointed file. */
    path: z.string(),
    created: z.boolean(),
  }),
  z.object({
    // A model API call whose settings differ from the previous call by the
    // same caller — `type: "api-request"` lines are written once per call, and
    // the parser emits only the first and the ones that changed something,
    // counting the identical calls after each into its `calls`, so the
    // transcript reads as a log of configuration changes.
    kind: z.literal("api-request"),
    at: z.string(),
    /** Claude Code's `querySource`: `repl_main_thread`, or a side caller. */
    source: z.string(),
    config: RequestConfigSchema,
    /** The same caller's previous settings; null on its first call. */
    previous: RequestConfigSchema.nullable(),
    /** Calls made with these settings, this one included: the identical calls
     *  that follow it are counted here rather than emitted as rows. */
    calls: z.number().int(),
  }),
  z.object({
    kind: z.literal("unknown"),
    at: z.string(),
    type: z.string(),
    raw: z.unknown(),
  }),
]);
export type JsonlEvent = z.infer<typeof JsonlEventSchema>;
