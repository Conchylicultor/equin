import type { ReactNode } from "react";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { WorkingText } from "@plugins/primitives/plugins/css/plugins/working-dots/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import {
  AttachmentText,
  rewriteAttachmentMarkdown,
} from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import { attachmentRefsOf } from "@plugins/conversations/core";
import { FieldRow, OptionBody, OptionRow } from "./option-row";
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

/**
 * Typed text as the one-line header summary shows it: attachments dropped (the
 * body draws them), line breaks as spaces.
 */
function summaryText(text: string): string {
  return rewriteAttachmentMarkdown(attachmentRefsOf(text), () => "")
    .replace(/\s+/g, " ")
    .trim();
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
        ...(first.otherText ? [summaryText(first.otherText)] : []),
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

const replyIcon = symbol("comment");
const noteIcon = symbol("notes");

/**
 * Text the user typed — an "Other" answer, a note, the reply — drawn as they
 * wrote it, one style for all three: plain foreground text, never italic (it is
 * the user's own words, not a placeholder or an aside).
 */
function WrittenText({ text }: { text: string }) {
  return (
    <Text
      as="div"
      variant="caption"
      className="whitespace-pre-wrap break-words text-foreground"
    >
      {/* The agent's record holds attachments as the disk paths it was
          handed; drawn back as the thumbnails the user pasted. */}
      <AttachmentText text={attachmentRefsOf(text)} />
    </Text>
  );
}

/**
 * Text the user wrote beside the picks — the reply to the whole question, or a
 * question's note — drawn as a row of the list it answers (the form's comment
 * field sits in the same place): its icon in the indicator column, the text as
 * the user wrote it, attachments and chips included. No callout bar: a left
 * edge reads as quoted or agent-authored, and this is the user's own answer.
 */
function WrittenRow({
  icon,
  label,
  text,
}: {
  icon: IconRef;
  label: string;
  text: string;
}) {
  return (
    <FieldRow icon={<Icon icon={icon} className="size-3" title={label} />}>
      <WrittenText text={text} />
    </FieldRow>
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
                  <WrittenText text={otherText} />
                </OptionRow>
              )}
              {notes != null && (
                <WrittenRow icon={noteIcon} label="Note" text={notes} />
              )}
            </Stack>
          </div>
        );
      })}
      {reply != null && (
        <WrittenRow icon={replyIcon} label="Reply" text={reply} />
      )}
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
