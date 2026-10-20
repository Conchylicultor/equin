import type { QuestionAnswer } from "@plugins/conversations/plugins/transcript-source/core";
import { ANSWER_MARKER } from "../../shared";

/**
 * Pure, React-free model for the AskUserQuestion tool: the question/answer
 * shapes plus the parsers that turn the harness's textual answer turns back into
 * structured selections. Kept separate from the rendering component so the
 * parsing contract is unit-testable without pulling in the web dependency tree.
 */

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface AskUserQuestionInput {
  questions: Question[];
}

/**
 * One question's answer as the form gives it: the picked option labels, and
 * the free text typed into "Other" (null when none — or, for a single-select,
 * when a preset is the active choice).
 */
export interface QuestionSelection {
  selected: string[];
  other: string | null;
}

/** A whole answer: one selection per question text. */
export type AnswerSelections = Record<string, QuestionSelection>;

/**
 * What the answer form submits: the per-question selections, plus the user's
 * own free-text reply to the whole question (null when none). With a reply,
 * `selections` holds only the questions the user actually answered — the
 * reply stands in for the rest.
 */
export interface FormAnswer {
  selections: AnswerSelections;
  response: string | null;
}

export interface ParsedAnswer {
  /** Answer value for option matching, or null when no option was selected. */
  answer: string | null;
  /** Free-form note the user attached to this question, if any. */
  notes: string | null;
}

// The CLI's own sentinel for a question answered with a note and no option.
const NO_SELECTION = "(no option selected)";

/**
 * Reads the CLI's structured answer record (the transcript line's
 * `toolUseResult`) into one `ParsedAnswer` per answered question. The result's
 * `content` is never parsed: it is the CLI's prose for the model, worded
 * differently across CLI versions.
 */
export function answersFromRecord(
  record: QuestionAnswer,
): Record<string, ParsedAnswer> {
  const answers: Record<string, ParsedAnswer> = {};
  for (const [question, value] of Object.entries(record.answers)) {
    answers[question] = {
      answer: value === NO_SELECTION || value === "" ? null : value,
      notes: record.annotations?.[question]?.notes ?? null,
    };
  }
  return answers;
}

/**
 * The legacy answer text: `ANSWER_MARKER` then one `- <header>: <value>` line
 * per question, the value being the picked labels and any typed text joined
 * with ", ". A free-text reply follows the lines as its own paragraph (the
 * parser reads only the positional `- ` lines, so it never mistakes it for an
 * answer). The inverse is `parseMarkerAnswer`.
 */
export function serializeMarkerAnswer(
  questions: Question[],
  { selections, response }: FormAnswer,
): string {
  const lines = questions.map((q) => {
    const s = selections[q.question];
    const parts = s ? [...s.selected, ...(s.other ? [s.other] : [])] : [];
    return `- ${q.header}: ${parts.join(", ")}`;
  });
  const reply = response ? `\n\n${response}` : "";
  return `${ANSWER_MARKER}\n\n${lines.join("\n")}${reply}`;
}

/**
 * Parses the follow-up answer turn (the `Answering your questions:` message
 * produced by `serializeAnswers`) into the same `Record<questionText,
 * ParsedAnswer>` shape `answersFromRecord` returns, so the answered-view JSX and
 * `parseSelectedLabels` consume it unchanged.
 *
 * The turn body is a list of `- <header>: <value>` lines, one per question in
 * the same order `serializeAnswers` emits them. We must NOT split each line on
 * its first `": "`: a question `header` can itself contain `": "` (e.g.
 * `"Scope: CLI fix"`), which would mis-key the value and drop the answer.
 * Instead we strip the exact, authoritative `"<header>: "` prefix — positionally
 * per question, so duplicate headers are also handled — leaving the delimiter
 * ambiguity irrelevant.
 */
export function parseMarkerAnswer(
  text: string,
  questions: Question[],
): Record<string, ParsedAnswer> {
  const body = text.trim().slice(ANSWER_MARKER.length);

  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));

  const answers: Record<string, ParsedAnswer> = {};
  questions.forEach((q, i) => {
    const prefix = `${q.header}: `;
    const line = lines[i];
    const value =
      line != null && line.startsWith(prefix)
        ? line.slice(prefix.length).trim() || null
        : null;
    answers[q.question] = { answer: value, notes: null };
  });
  return answers;
}

// Separator the harness (and `serializeAnswers`) joins multi-select parts with.
const SEPARATOR = ", ";

export function parseSelectedLabels(
  answer: string | undefined,
  options: QuestionOption[],
): { selected: Set<string>; otherText: string | null } {
  if (answer == null) return { selected: new Set(), otherText: null };

  if (options.some((o) => o.label === answer)) {
    return { selected: new Set([answer]), otherText: null };
  }

  // Labels may themselves contain ", " (e.g. "46px toolbar, no border"), so the
  // answer cannot be split on the separator first. Walk it instead: at each
  // part boundary, claim the longest option label that ends on a boundary;
  // anything no label claims is free-form text, kept verbatim.
  const labels = [...new Set(options.map((o) => o.label))].sort(
    (a, b) => b.length - a.length,
  );
  const matched = new Set<string>();
  const unmatched: string[] = [];

  let i = 0;
  while (i <= answer.length) {
    const label = labels.find(
      (l) =>
        answer.startsWith(l, i) &&
        (i + l.length === answer.length ||
          answer.startsWith(SEPARATOR, i + l.length)),
    );
    if (label != null) {
      matched.add(label);
      i += label.length + SEPARATOR.length;
      continue;
    }
    const next = answer.indexOf(SEPARATOR, i);
    const end = next === -1 ? answer.length : next;
    unmatched.push(answer.slice(i, end));
    i = end + SEPARATOR.length;
  }

  if (matched.size > 0) {
    return {
      selected: matched,
      otherText: unmatched.length > 0 ? unmatched.join(SEPARATOR) : null,
    };
  }

  return { selected: new Set(), otherText: answer };
}
