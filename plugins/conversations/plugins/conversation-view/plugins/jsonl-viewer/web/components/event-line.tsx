import type { ReactNode } from "react";
import { TimelineLine } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";

/**
 * The shared one-line grammar for ambient / lifecycle rows in the transcript —
 * queue operations, system lines, task completions. A leading indicator (a
 * status dot or a small icon) carries any semantic colour; the label is a
 * natural-case muted eyebrow (never all-caps — jsonl-viewer rule); trailing
 * content follows. Every tier-1 lifecycle renderer composes this so the rows
 * read as siblings instead of each inventing its own chrome.
 *
 * Colour lives ONLY in the leading indicator — never a filled badge — so the
 * timeline stays calm. Truncation is the caller's job: wrap a flexible leaf in
 * `truncate` so only that text ellipsizes while chips stay whole.
 */
export function EventLine({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  children?: ReactNode;
}) {
  return (
    <TimelineLine icon={icon} label={label}>
      {children}
    </TimelineLine>
  );
}
