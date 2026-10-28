import { z } from "zod";
import { attachmentRefsOf } from "@plugins/conversations/core";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import {
  DEFAULT_DRAFT_TTL,
  legacyDraftKeys,
  writeDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import {
  replyOf,
  type QuestionAnswer as AnswerRecord,
} from "@plugins/conversations/plugins/transcript-source/core";
import {
  answersFromRecord,
  parseMarkerAnswer,
  parseSelectedLabels,
  type ParsedAnswer,
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
 * `serializeMarkerAnswer`, used to reopen an answered question with the
 * previous answer already filled in.
 */
export function answersFromText(
  questions: Question[],
  answerText: string,
): QuestionAnswer[] {
  return formAnswers(
    questions,
    parseMarkerAnswer(answerText, questions).answers,
  );
}

function formAnswers(
  questions: Question[],
  parsed: Record<string, ParsedAnswer>,
): QuestionAnswer[] {
  return questions.map((q) => {
    const { selected, otherText } = parseSelectedLabels(
      parsed[q.question]?.answer ?? undefined,
      q.options,
    );
    return {
      selected: [...selected],
      // Typed text holds attachments as the disk paths the agent was handed.
      otherText: otherText === null ? "" : attachmentRefsOf(otherText),
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
  const scope = answerDraftScope(convId, toolUseId);
  const { answers, reply } = parseMarkerAnswer(answerText, questions);
  writeDraft(answerDraftStore, formAnswers(questions, answers), { scope });
  if (reply !== null) {
    writeDraft(responseDraftStore, attachmentRefsOf(reply), { scope });
  }
}

/**
 * Pre-fill a question's answer form in `convId` with an answer given as the
 * tool's real result — its structured record (the line's `toolUseResult`),
 * the free-text reply included.
 */
export function restoreAnswerDraftFromRecord(
  convId: string,
  toolUseId: string,
  questions: Question[],
  record: AnswerRecord,
): void {
  const scope = answerDraftScope(convId, toolUseId);
  writeDraft(
    answerDraftStore,
    formAnswers(questions, answersFromRecord(record)),
    {
      scope,
    },
  );
  const reply = replyOf(record);
  if (reply !== undefined) {
    writeDraft(responseDraftStore, attachmentRefsOf(reply), { scope });
  }
}
