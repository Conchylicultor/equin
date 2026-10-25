import type { ReactNode } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { WorkingText } from "@plugins/primitives/plugins/css/plugins/working-dots/web";
import { OptionBody, OptionRow } from "./option-row";
import { summaryFor } from "./question-card";
import {
  parseSelectedLabels,
  type FormAnswer,
  type ParsedAnswer,
  type Question,
} from "./answer-model";

/** One question's answer as the answered view draws it. */
export interface DrawnSelection {
  selected: Set<string>;
  otherText: string | null;
  notes: string | null;
}

/** Selections read back from a parsed answer map (a record, or an answer turn). */
export function selectionsFromParsed(
  questions: Question[],
  answerMap: Record<string, ParsedAnswer> | null,
): DrawnSelection[] {
  return questions.map((q) => {
    const parsed = answerMap?.[q.question];
    const { selected, otherText } = parseSelectedLabels(
      parsed?.answer ?? undefined,
      q.options,
    );
    return { selected, otherText, notes: parsed?.notes ?? null };
  });
}

/** Selections of an answer the form just sent — before any record of it exists. */
export function selectionsFromForm(
  questions: Question[],
  { selections }: FormAnswer,
): DrawnSelection[] {
  return questions.map((q) => {
    const s = selections[q.question];
    return {
      selected: new Set(s?.selected ?? []),
      otherText: s?.other ?? null,
      notes: null,
    };
  });
}

/** The card header's summary for an answered question: the first answer, or the reply. */
export function answeredSummary(
  questions: Question[],
  selections: DrawnSelection[],
  reply: string | null,
) {
  const first = selections[0];
  const parts = first
    ? [
        ...first.selected,
        ...(first.otherText ? [first.otherText] : []),
        // Fall back to the note when the user attached one without picking an option.
        ...(first.selected.size === 0 && !first.otherText && first.notes
          ? [first.notes]
          : []),
      ]
    : [];
  // A reply given in place of the answers stands in for them in the summary.
  return summaryFor(
    questions,
    parts.length === 0 && reply != null ? [reply] : parts,
  );
}

function Callout({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-md border-l-2 border-muted-foreground/30 bg-muted/40 py-xs pl-sm">
      <p className="text-3xs font-medium tracking-wider text-muted-foreground">
        {label}
      </p>
      <Text
        as="p"
        variant="caption"
        className="whitespace-pre-wrap break-words text-foreground"
      >
        {text}
      </Text>
    </div>
  );
}

/**
 * The read-only body of an answered question: every question with its option
 * list, the picks highlighted, then the reply. Drawn the same whether the
 * answer is in the transcript or still on its way (`footer` then carries the
 * in-flight line), so nothing moves when the transcript takes over.
 */
export function AnsweredQuestions({
  questions,
  selections,
  reply,
  footer,
}: {
  questions: Question[];
  selections: DrawnSelection[];
  reply: string | null;
  footer?: ReactNode;
}) {
  return (
    // eslint-disable-next-line spacing/no-adhoc-spacing -- mt offsets the answered view from the question card above (no named margin utility)
    <Stack gap="md" className="mt-2">
      {questions.map((q, qi) => {
        const { selected, otherText, notes } = selections[qi] ?? {
          selected: new Set<string>(),
          otherText: null,
          notes: null,
        };
        const hasAnswer = selected.size > 0 || otherText != null;

        return (
          <div key={qi}>
            {questions.length > 1 && (
              <p
                // eslint-disable-next-line spacing/no-adhoc-spacing -- mb separates the per-question header from its question text (no named margin utility)
                className="mb-1 text-3xs font-medium tracking-wider text-muted-foreground"
              >
                {q.header}
              </p>
            )}
            {/* eslint-disable-next-line spacing/no-adhoc-spacing -- mb separates the question text from its option list (no named margin utility) */}
            <Text as="p" variant="caption" className="mb-1.5 text-foreground">
              {q.question}
            </Text>
            <Stack gap="xs">
              {q.options.map((opt, oi) => (
                <OptionRow
                  key={oi}
                  selected={selected.has(opt.label)}
                  multi={q.multiSelect}
                  dimmed={hasAnswer}
                >
                  <OptionBody
                    label={opt.label}
                    description={opt.description}
                    preview={opt.preview}
                  />
                </OptionRow>
              ))}
              {otherText != null && (
                <OptionRow selected multi={q.multiSelect}>
                  <Text
                    as="p"
                    variant="caption"
                    className="italic text-foreground"
                  >
                    {otherText}
                  </Text>
                </OptionRow>
              )}
              {notes != null && <Callout label="Note" text={notes} />}
            </Stack>
          </div>
        );
      })}
      {reply != null && <Callout label="Reply" text={reply} />}
      {footer}
    </Stack>
  );
}

/**
 * The in-flight line under an answer still on its way — the same caption a
 * user message's echo carries (conversation-view/pending-turn).
 */
export function SendingStatus() {
  return (
    <Text as="div" variant="caption">
      <WorkingText>Sending…</WorkingText>
    </Text>
  );
}
