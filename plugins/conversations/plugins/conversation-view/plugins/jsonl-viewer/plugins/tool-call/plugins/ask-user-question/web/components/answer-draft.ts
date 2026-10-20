import { z } from "zod";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import {
  DEFAULT_DRAFT_TTL,
  legacyDraftKeys,
  writeDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import {
  parseMarkerAnswer,
  parseSelectedLabels,
  type Question,
} from "./answer-model";

// Persisted shape: `selected` is a string[] (not a Set) so the draft survives a
// JSON round-trip through localStorage via useDraft. `otherText` is a buffer
// that is ALWAYS preserved — selecting a preset never clears it. For
// single-select questions, `otherActive` is the pointer that says which of the
// two buffers (a preset in `selected`, or `otherText`) is the live answer, so
// the user can flip between a preset and their typed text without losing
// either. Multi-select ignores `otherActive`: there the freeform is additive.
export interface QuestionAnswer {
  selected: string[];
  otherText: string;
  otherActive: boolean;
}

export const answerDraftStore = defineStore<QuestionAnswer[]>({
  owner: "ask-user-question.answer",
  label: "Question answer drafts",
  area: "local",
  cap: "128 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "refuse",
  schema: z.array(
    z.object({
      selected: z.array(z.string()),
      otherText: z.string(),
      otherActive: z.boolean(),
    }),
  ),
  legacy: legacyDraftKeys("ask-user-question:answer"),
});
/** The free-text reply's draft — same scope as the answer's. */
export const responseDraftStore = defineStore({
  owner: "ask-user-question.response",
  label: "Question reply drafts",
  area: "local",
  cap: "128 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "refuse",
  schema: z.string(),
  legacy: legacyDraftKeys("ask-user-question:response"),
});

// Scoping by the tool-use id (unique per question) means a restored draft
// always belongs to the exact question still on screen, and never collides
// with another question in the same conversation. A fork keeps the tool-use id,
// so the same scope under the fork's id finds the question there too.
export function answerDraftScope(convId: string, toolUseId: string): string {
  return `${convId}:${toolUseId}`;
}

export function emptyAnswers(questions: Question[]): QuestionAnswer[] {
  return questions.map(() => ({
    selected: [],
    otherText: "",
    otherActive: false,
  }));
}

/**
 * The form state that re-serializes to `answerText` — the inverse of
 * `serializeAnswers`, used to reopen an answered question with the previous
 * answer already filled in.
 */
export function answersFromText(
  questions: Question[],
  answerText: string,
): QuestionAnswer[] {
  const parsed = parseMarkerAnswer(answerText, questions);
  return questions.map((q) => {
    const { selected, otherText } = parseSelectedLabels(
      parsed[q.question]?.answer ?? undefined,
      q.options,
    );
    return {
      selected: [...selected],
      otherText: otherText ?? "",
      otherActive: !q.multiSelect && otherText != null,
    };
  });
}

/** Pre-fill a question's answer form in `convId` with a previously sent answer. */
export function restoreAnswerDraft(
  convId: string,
  toolUseId: string,
  questions: Question[],
  answerText: string,
): void {
  writeDraft(answerDraftStore, answersFromText(questions, answerText), {
    scope: answerDraftScope(convId, toolUseId),
  });
}
