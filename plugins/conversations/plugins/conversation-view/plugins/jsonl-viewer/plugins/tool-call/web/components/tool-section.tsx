import type { ReactNode } from "react";
import type { ToolCallEvent } from "../../core";
import { CopyTextAction } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/row-actions/web";
import { formatDuration } from "@plugins/fields/plugins/duration/core";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  StatusDot,
  type StatusDotPaint,
} from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ContentScope } from "@plugins/primitives/plugins/select-scope/web";

/**
 * How a section's subject ended, as its header says it: a dot in the tone and
 * the words beside it (`exit 0 · 1.3s`). `ok` / `error` are the call's own
 * verdict; `unknown` is a call the session lost in flight (`outcomeUnknown`).
 */
export interface ToolSectionStatus {
  tone: "ok" | "error" | "unknown";
  text: string;
}

const STATUS_PAINT: Record<ToolSectionStatus["tone"], StatusDotPaint> = {
  ok: { colorClass: "bg-success" },
  error: { colorClass: "bg-destructive" },
  unknown: { ringClass: "border-muted-foreground" },
};

/**
 * The status of a call's result for its Output header: the tone from the
 * result's error flags, the text `<detail> · <duration>` — the duration read
 * from the call's and the result's own timestamps, left out when they do not
 * give one. `undefined` while there is no result.
 */
export function toolResultStatus(
  event: ToolCallEvent,
  detail?: string,
): ToolSectionStatus | undefined {
  const result = event.result;
  if (!result) return undefined;
  const tone = result.outcomeUnknown
    ? "unknown"
    : result.isError
      ? "error"
      : "ok";
  const ms = Date.parse(result.at) - Date.parse(event.at);
  const duration =
    Number.isFinite(ms) && ms >= 0 ? formatDuration(ms) : undefined;
  const words =
    detail ??
    (tone === "unknown" ? "interrupted" : tone === "error" ? "error" : "");
  return {
    tone,
    text: [words, duration].filter((w) => w !== "" && w != null).join(" · "),
  };
}

/**
 * One labelled part of an opened tool call (its Input, its Output): a quiet
 * header line — the label, an optional status, a copy button flush right — over
 * the part's content, with no box around either. Sections stack with no rule
 * between them; the card's own body spacing separates them.
 */
export function ToolSection({
  label,
  copyText,
  status,
  children,
}: {
  label: string;
  /** What the copy button copies; no button when absent. */
  copyText?: string;
  status?: ToolSectionStatus;
  children: ReactNode;
}) {
  return (
    <section aria-label={label}>
      <Line className="control-xs gap-sm pl-smd pr-xs">
        <Text variant="caption" tone="muted" className="font-medium">
          {label}
        </Text>
        {status && status.text !== "" && (
          <Stack as="span" direction="row" align="center" gap="xs">
            <StatusDot {...STATUS_PAINT[status.tone]} />
            <Text variant="caption" tone="muted" className="tabular-nums">
              {status.text}
            </Text>
          </Stack>
        )}
        <Fill />
        {copyText !== undefined && (
          <CopyTextAction
            text={copyText}
            title={`Copy ${label.toLowerCase()}`}
          />
        )}
      </Line>
      <ContentScope fill={false}>{children}</ContentScope>
    </section>
  );
}

/**
 * A section's text, as code: monospaced, muted, wrapping, scrolling past a
 * fixed height — on no fill, aligned with its section's label. `error` draws
 * a failed result in the destructive tone.
 */
export function ToolCode({
  tone = "default",
  children,
}: {
  tone?: "default" | "error";
  children: ReactNode;
}) {
  return (
    <Scroll className="max-h-56">
      <Text
        as="pre"
        variant="code"
        tone={tone === "error" ? "destructive" : "muted"}
        className="whitespace-pre-wrap break-words px-smd pb-sm"
      >
        {children}
      </Text>
    </Scroll>
  );
}

/** The faint stand-in a section's code shows when the result is empty. */
export function ToolCodeEmpty({ children }: { children: ReactNode }) {
  return (
    <Text tone="faint" className="italic">
      {children}
    </Text>
  );
}

/**
 * A call's result as its Output section: the status (`toolResultStatus`, with
 * the renderer's `detail` — an exit code), the copy button, and the text as
 * code — in the error tone for a failed call (never for one whose outcome is
 * unknown), `empty` standing in for an empty result. `text` overrides the
 * result's own content (an ANSI-stripped output, a parsed remainder). Nothing
 * while the call has no result.
 */
export function ToolOutput({
  event,
  text,
  detail,
  empty = "(empty)",
}: {
  event: ToolCallEvent;
  text?: string;
  detail?: string;
  empty?: string;
}) {
  const result = event.result;
  if (!result) return null;
  const content = text ?? result.content;
  return (
    <ToolSection
      label="Output"
      copyText={content}
      status={toolResultStatus(event, detail)}
    >
      <ToolCode
        tone={result.isError && !result.outcomeUnknown ? "error" : "default"}
      >
        {content || <ToolCodeEmpty>{empty}</ToolCodeEmpty>}
      </ToolCode>
    </ToolSection>
  );
}
