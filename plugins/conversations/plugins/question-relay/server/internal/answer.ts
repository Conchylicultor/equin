import type {
  AnswerQuestionBody,
  CliAnswer,
  RelayQuestion,
} from "../../core/schemas";
import { withPicksInResponse } from "@plugins/conversations/plugins/transcript-source/core";

// The web's structured answer → the AskUserQuestion tool's own answer shape,
// checked against the questions the relay registered. Pure, so every rule is a
// unit test (answer.test.ts).

/** Joins a multi-select answer: the CLI's own separator (Phase 0). */
const MULTI_SEPARATOR = ", ";
/** The CLI's own sentinel for "nothing picked" — the answered view reads it. */
const NO_SELECTION = "(no option selected)";

export type AnswerCheck =
  { ok: true; answer: CliAnswer } | { ok: false; error: string };

export function toCliAnswer(
  questions: readonly RelayQuestion[],
  body: AnswerQuestionBody,
): AnswerCheck {
  const byText = new Map(questions.map((q) => [q.question, q]));
  for (const key of Object.keys(body.selections)) {
    if (!byText.has(key))
      return { ok: false, error: `unknown question: ${key}` };
  }
  for (const key of Object.keys(body.annotations ?? {})) {
    if (!byText.has(key)) {
      return { ok: false, error: `notes on an unknown question: ${key}` };
    }
  }

  const answers: Record<string, string> = {};
  for (const q of questions) {
    const selection = body.selections[q.question];
    if (!selection) {
      // A top-level `response` stands in for the answers; otherwise every
      // question needs one.
      if (body.response !== undefined) continue;
      return { ok: false, error: `unanswered question: ${q.question}` };
    }
    const labels = new Set(q.options.map((o) => o.label));
    for (const label of selection.selected) {
      if (!labels.has(label)) {
        return {
          ok: false,
          error: `"${label}" is not an option of: ${q.question}`,
        };
      }
    }
    if (new Set(selection.selected).size !== selection.selected.length) {
      return { ok: false, error: `a label picked twice in: ${q.question}` };
    }
    const other = selection.other?.trim() ?? "";
    const parts = [...selection.selected, ...(other ? [other] : [])];
    if (!q.multiSelect && parts.length !== 1) {
      return {
        ok: false,
        error: `exactly one answer expected for: ${q.question}`,
      };
    }
    answers[q.question] =
      parts.length > 0 ? parts.join(MULTI_SEPARATOR) : NO_SELECTION;
  }

  return {
    ok: true,
    // A reply replaces the answers in what the model reads: spell the picks
    // into it, so the model sees both.
    answer: withPicksInResponse({
      answers,
      ...(body.annotations ? { annotations: body.annotations } : {}),
      ...(body.response !== undefined ? { response: body.response } : {}),
    }),
  };
}
