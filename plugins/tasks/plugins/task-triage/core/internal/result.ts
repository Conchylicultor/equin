import { z } from "zod";
import {
  MAX_TRIAGE_ANSWERS,
  MAX_TRIAGE_AREAS,
  TRIAGE_PRIORITIES,
  TRIAGE_RISKS,
  TRIAGE_TASK_TYPES,
  TRIAGE_VERDICTS,
} from "./vocabulary";

/**
 * What a triage agent submits (`task_submit_triage`'s input) — the read
 * itself, without anything the server knows better (which task, when, at
 * which commit). Its `.shape` is the MCP tool's input schema, so the record is
 * checked where it is produced.
 */
export const TriageResultSchema = z.object({
  verdict: z
    .enum(TRIAGE_VERDICTS)
    .describe(
      "ready: an unattended agent can do it without asking · decide: one call is the person's (ask it) · split: too big for one session (propose the split as the question) · obsolete: already fixed on main, or the code it names is gone",
    ),
  priority: z
    .enum(TRIAGE_PRIORITIES)
    .describe(
      "MoSCoW for the current timebox — must: without it the release is not viable · should: painful to leave out, but there is a workaround · could: desirable, small impact if dropped, the first cut · wont: explicitly out of scope this time (not 'never')",
    ),
  taskType: z
    .enum(TRIAGE_TASK_TYPES)
    .describe(
      "feature · bugfix (something is actually broken) · cleanup · testing · other",
    ),
  risk: z
    .enum(TRIAGE_RISKS)
    .describe(
      "high: behaviour a person relies on, a shared primitive, a schema, auth or the gateway · medium: a contained behaviour change · low: a local fix nobody would notice except as 'fixed'",
    ),
  context: z
    .string()
    .min(1)
    .describe(
      "Markdown for someone who has never seen this code: the problem, why it matters, how it could be fixed, what makes it risky or hard.",
    ),
  question: z
    .string()
    .min(1)
    .nullable()
    .describe(
      "ONE question the person can answer in a click, or null when there is none.",
    ),
  answers: z
    .array(z.string().min(1).max(60))
    .max(MAX_TRIAGE_ANSWERS)
    .describe(
      `The question's 2–${MAX_TRIAGE_ANSWERS} short answers (a few words each); empty when there is no question.`,
    ),
  areas: z
    .array(z.string().min(1))
    .max(MAX_TRIAGE_AREAS)
    .describe(
      "The plugin paths it would touch (`tasks/automations`, `shell/health-report`, …).",
    ),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

/**
 * A question without answers (or answers without a question) is half a
 * question: keep the pair only when both are there.
 */
export function normalizeTriageResult(result: TriageResult): TriageResult {
  const asks = result.question !== null && result.answers.length > 0;
  return {
    ...result,
    question: asks ? result.question : null,
    answers: asks ? result.answers : [],
  };
}
