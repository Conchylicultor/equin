import { type ReactNode } from "react";
import { toolName, type ToolCallEvent } from "../../core";
import { ToolNameLabel } from "./tool-name-label";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { BouncingDots } from "@plugins/primitives/plugins/css/plugins/bouncing-dots/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  CollapsibleCard,
  CardHeaderAction,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";

interface ToolCallFrameProps {
  /** The tool's name as the model calls it, drawn as the card's identity
   *  badge. An MCP tool (`mcp__<server>__<tool>`) reads `<server>:<tool>`, its
   *  server dimmed; the raw name stays on hover. */
  name: string;
  summary?: ReactNode;
  /** Muted middot-led count after the identity (`· 3 matches`) — the card's
   *  `note`. Names what it counted; never a bare parenthesised number. */
  note?: ReactNode;
  /** Interactive chip rendered right after the tool-name badge and before the
   *  summary — e.g. a skill-name chip. Wrapped in `<CardHeaderAction>` so it
   *  stays clickable while the rest of the row still toggles the card. */
  leading?: ReactNode;
  /** Sibling affordance next to (never inside) the trigger — e.g. a clickable
   *  FilePath. Interactive content belongs here, never in `summary`. */
  aside?: ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean;
  /**
   * The error tone. `ToolCallCard` derives it from `event.result?.isError`
   * unless the renderer overrides it: renderers whose protocol-level error is an expected
   * mechanism artifact (e.g. AskUserQuestion's cancel-to-flush interrupt) pass
   * `false` so the card is not styled as a failure.
   */
  isError?: boolean;
  /**
   * "Is this call still in flight" (draws the running dots). `ToolCallCard`
   * derives it from `event.result` being absent unless the renderer overrides it.
   *
   * For one tool family that derivation is simply wrong: a backgrounded `Agent`
   * gets its `tool_result` at LAUNCH, as an acknowledgement, so the card would
   * drop its running dots the instant a sub-agent starts and would show a
   * killed sub-agent as finished. A renderer that can actually answer the
   * question — because it reads the completion signal the harness really uses —
   * says so here, and the card believes it.
   */
  running?: boolean;
}

/**
 * A tool call's card, drawn from its name alone — for a call that is not (yet)
 * a transcript event, such as an AskUserQuestion a hook is holding. Renderers
 * of a transcript event use `ToolCallCard`, which derives the rest from it.
 */
export function ToolCallFrame({
  name,
  summary,
  note,
  leading,
  aside,
  children,
  defaultOpen = false,
  isError,
  running,
}: ToolCallFrameProps) {
  const tool = toolName(name);
  return (
    <CollapsibleCard
      error={isError}
      defaultOpen={defaultOpen}
      summary={summary}
      note={note}
      aside={aside}
      trailing={running ? <BouncingDots /> : undefined}
      label={
        // Rigid identity only: the tool-name badge + an optional leading chip.
        // The flexible `summary` rides the card's own flexible cell (passed as a
        // prop), not bundled here — so identity stays shrink-0 and never strands
        // the grow slot.
        <>
          <Badge
            colorClass={
              isError
                ? "bg-destructive/15 text-destructive"
                : "bg-primary/10 text-primary-text"
            }
            tooltip={tool.server ? tool.id : undefined}
            // The badge's shape is the tool-badge tokens (density
            // `padToolBadge*`, shape `radiusToolBadge` / `borderToolBadge`);
            // its words are the `tag` role at its strong weight, pinned so the
            // `xs` card does not step it to the compact rung. Its hairline,
            // when a theme draws one, is its own text colour at 28%.
            className={cn(
              rigidClass(),
              "font-mono p-tool-badge text-tag font-tag-strong rounded-tool-badge hairline-tool-badge border-current/28",
            )}
          >
            <ToolNameLabel tool={tool} />
          </Badge>
          {/* Interactive chip sits inside the (click-through) label, so it opts
              back into pointer events via CardHeaderAction to keep its onClick. */}
          {leading && (
            <CardHeaderAction className={rigidClass()}>
              {leading}
            </CardHeaderAction>
          )}
        </>
      }
    >
      {children}
    </CollapsibleCard>
  );
}

type ToolCallCardProps = Omit<ToolCallFrameProps, "name"> & {
  event: ToolCallEvent;
  /**
   * The session ended while the call was in flight, so whether it took effect
   * is unknown (`result.outcomeUnknown`): drawn in the neutral tone with an
   * "outcome unknown" note, not as a failure. Derived from the event unless
   * the renderer overrides it — one whose tool cannot have taken effect (an
   * AskUserQuestion, re-answerable as a message) passes `false`.
   */
  outcomeUnknown?: boolean;
};

/** A transcript tool call's card: name, error tone and in-flight state derived from the event. */
export function ToolCallCard({
  event,
  isError,
  running,
  outcomeUnknown,
  note,
  ...frame
}: ToolCallCardProps) {
  const unknown = outcomeUnknown ?? event.result?.outcomeUnknown === true;
  return (
    <ToolCallFrame
      {...frame}
      name={event.name || "tool_call"}
      isError={isError ?? (event.result?.isError === true && !unknown)}
      note={note ?? (unknown ? "· session ended, outcome unknown" : undefined)}
      running={running ?? !event.result}
    />
  );
}
