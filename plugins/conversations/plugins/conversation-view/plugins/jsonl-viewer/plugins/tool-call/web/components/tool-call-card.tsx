import { type ReactNode, use } from "react";
import { ToolFooterContext } from "../internal/footer-context";
import { blockingHook, isLoudHook, toolName, type ToolCall } from "../../core";
import { ToolNameTitle } from "./tool-name-label";
import { ToolIconContext } from "../internal/icon-context";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { HookBand, HookIndicator } from "./hook-band";
import type { HookRecord } from "@plugins/conversations/plugins/transcript-source/core";
import { BouncingDots } from "@plugins/primitives/plugins/css/plugins/bouncing-dots/web";
import { ElapsedTime } from "@plugins/primitives/plugins/relative-time/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useBlockWriting } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  CollapsibleCard,
  CardHeaderAction,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web";

/** The node glyph of a call whose renderer names none. */
const DEFAULT_TOOL_ICON = symbol("build");

interface ToolCallFrameProps {
  /** The glyph on the row's timeline node. `ToolCallCard` reads it from the
   *  renderer's contribution (`icon`); absent, the generic tool glyph. */
  icon?: IconRef;
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
  /** When the call began (ISO): while it runs, the header counts the time
   *  since. `ToolCallCard` passes the event's `at`. */
  startedAt?: string;
  /** What the open body says in place of the result while the call runs
   *  (`Waiting for result…`). `ToolCallCard` derives it from the event. */
  pendingLabel?: string;
  /** The hooks that ran on the call: a shield beside the tool badge (coloured
   *  by the worst outcome) on the closed card, and what the loud ones said (a
   *  block, a failure, added context) at the top of the opened body. */
  hooks?: readonly HookRecord[];
  /** Always-shown content inside the card under its header (the card's
   *  `footer`), beside its timeline rail. `ToolCallCard` adds the call's
   *  `JsonlViewerTool.Footer` after the renderer's own. */
  footer?: ReactNode;
}

/**
 * A tool call's card, drawn from its name alone — for a call that is not (yet)
 * a transcript event, such as an AskUserQuestion a hook is holding. Renderers
 * of a transcript event use `ToolCallCard`, which derives the rest from it.
 */
export function ToolCallFrame({
  icon = DEFAULT_TOOL_ICON,
  name,
  summary,
  note,
  leading,
  aside,
  children,
  defaultOpen = false,
  isError,
  running,
  startedAt,
  pendingLabel,
  hooks,
  footer,
}: ToolCallFrameProps) {
  const tool = toolName(name);
  // A running call is never an empty card: the header counts the time since
  // it began, and the open body says what it waits on where the result goes.
  const pending = running && pendingLabel !== undefined && (
    <Text variant="caption" className="text-muted-foreground">
      {pendingLabel}
    </Text>
  );
  return (
    <CollapsibleCard
      variant="ghost"
      icon={<Icon icon={icon} className="size-3.5" />}
      error={isError}
      defaultOpen={defaultOpen}
      summary={summary}
      note={note}
      aside={aside}
      trailing={
        running ? (
          <Stack as="span" direction="row" align="center" gap="xs">
            <BouncingDots />
            {startedAt && (
              <ElapsedTime
                since={new Date(startedAt)}
                className="tabular-nums text-muted-foreground"
              />
            )}
          </Stack>
        ) : undefined
      }
      footer={footer}
      label={
        // Rigid identity only: the tool's name + an optional leading chip.
        // The flexible `summary` rides the card's own flexible cell (passed as a
        // prop), not bundled here — so identity stays shrink-0 and never strands
        // the grow slot.
        <>
          <ToolNameTitle tool={tool} error={isError} />
          {/* The hook shield keeps its own hover (the list of hooks), so it
              opts back into pointer events like the leading chip. */}
          {hooks?.length ? (
            <CardHeaderAction className={rigidClass()}>
              <HookIndicator hooks={hooks} />
            </CardHeaderAction>
          ) : null}
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
      {hooks?.some(isLoudHook) && <HookBand hooks={hooks} />}
      {children}
      {pending}
    </CollapsibleCard>
  );
}

type ToolCallCardProps = Omit<ToolCallFrameProps, "name"> & {
  event: ToolCall;
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
  const footer = use(ToolFooterContext);
  const declaredFor = use(ToolIconContext);
  const declared =
    declaredFor?.toolUseId === event.toolUseId ? declaredFor.icon : undefined;
  const icon =
    frame.icon ?? (typeof declared === "function" ? declared(event) : declared);
  // The renderer's own footer first (what the call is doing now), then what
  // the call left behind (`JsonlViewerTool.Footer`).
  const contributed =
    footer?.toolUseId === event.toolUseId ? footer.footer : undefined;
  const blocked = blockingHook(event) !== undefined;
  // A stand-in the model is still writing has not been sent yet.
  const writing = useBlockWriting();
  return (
    <ToolCallFrame
      {...frame}
      icon={icon}
      name={event.name || "tool_call"}
      isError={isError ?? (event.result?.isError === true && !unknown)}
      note={
        note ??
        (unknown
          ? "· session ended, outcome unknown"
          : blocked
            ? "· did not run"
            : undefined)
      }
      running={running ?? !event.result}
      startedAt={event.at}
      pendingLabel={
        writing
          ? "Writing the call…"
          : event.result
            ? "Running…"
            : "Waiting for result…"
      }
      hooks={event.hooks}
      footer={
        frame.footer === undefined && contributed === undefined ? undefined : (
          <>
            {frame.footer}
            {contributed}
          </>
        )
      }
    />
  );
}
