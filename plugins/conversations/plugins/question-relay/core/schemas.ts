import { z } from "zod";

// The question as the CLI hands it to the hook (`tool_input.questions`). The
// defaults are the AskUserQuestion tool's own: a hook sees the input as the
// model wrote it, so a field the model may omit is defaulted here, once.
export const RelayQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().default(""),
  preview: z.string().optional(),
});

export const RelayQuestionSchema = z.object({
  question: z.string(),
  header: z.string().default(""),
  options: z.array(RelayQuestionOptionSchema),
  multiSelect: z.boolean().default(false),
});
export type RelayQuestion = z.infer<typeof RelayQuestionSchema>;

export const RelayQuestionsSchema = z.array(RelayQuestionSchema).min(1);

/**
 * A held question's lifecycle: `open` until exactly one of
 * - `answered` — the web answered; the holder hands the answer to the agent;
 * - `abandoned` — the holder stopped waiting (the agent withdrew the question,
 *   or died).
 *
 * `released` is history: "Answer in terminal" on the retired tmux runtime,
 * kept so the rows it wrote still parse. Nothing writes it any more.
 */
export const RelayStateSchema = z.enum([
  "open",
  "answered",
  "released",
  "abandoned",
]);
export type RelayState = z.infer<typeof RelayStateSchema>;

/**
 * The answer in the AskUserQuestion tool's OWN input shape — what the relay
 * merges into `updatedInput`. Every value is a string: a multi-select answer is
 * its labels joined with ", " (an array is accepted by the CLI but degrades —
 * the model sees `Leek,Corn` and the pane draws no answer block).
 */
export const CliAnswerSchema = z.object({
  answers: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.object({ notes: z.string() })).optional(),
  response: z.string().optional(),
});
export type CliAnswer = z.infer<typeof CliAnswerSchema>;

/** Where a held question stands, as its holder reads it. */
export const RelayResolutionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("open") }),
  z.object({ state: z.literal("answered"), answer: CliAnswerSchema }),
  z.object({ state: z.literal("released") }),
  z.object({ state: z.literal("abandoned") }),
]);
export type RelayResolution = z.infer<typeof RelayResolutionSchema>;

export const RegisterQuestionBodySchema = z.object({
  toolUseId: z.string().min(1),
  questions: RelayQuestionsSchema,
  /** The holder's pid — its liveness is how a dead hold is noticed. */
  pid: z.number().int().positive(),
});
export type RegisterQuestionBody = z.infer<typeof RegisterQuestionBodySchema>;

/**
 * One question's answer as the web form gives it: the picked option labels and
 * the free text typed into "Other" (null when none). Structured, so the server
 * can tell an unknown label from free text — the CLI string cannot.
 */
export const QuestionSelectionSchema = z.object({
  selected: z.array(z.string()),
  other: z.string().nullable(),
});
export type QuestionSelection = z.infer<typeof QuestionSelectionSchema>;

/** The web's answer: one selection per question text, plus optional notes. */
export const AnswerQuestionBodySchema = z.object({
  selections: z.record(z.string(), QuestionSelectionSchema),
  annotations: z
    .record(z.string(), z.object({ notes: z.string().min(1) }))
    .optional(),
  /** Free text in place of the answers ("The user responded: …"). */
  response: z.string().min(1).optional(),
});
export type AnswerQuestionBody = z.infer<typeof AnswerQuestionBodySchema>;

/** An open held question, as the web reads it. */
export const PendingQuestionSchema = z.object({
  toolUseId: z.string(),
  conversationId: z.string(),
  questions: RelayQuestionsSchema,
  createdAt: z.coerce.date(),
});
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;
