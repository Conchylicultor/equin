import type React from "react";
import { useState, useRef, type ReactNode } from "react";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import {
  CollapsibleContent,
  CollapsibleProvider,
} from "@plugins/primitives/plugins/collapsible/web";
import {
  cn,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { SectionHeaderRow } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  JumpToBottomButton,
  useStickyScroll,
} from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import {
  useReconnectingWebSocket,
  useTransport,
} from "@plugins/primitives/plugins/networking/web";
import { unavailableMessage } from "@plugins/infra/plugins/endpoints/core";
import type { ClientMessage, LogEntryWire, ServerMessage } from "../../core";
import { textVariantClass } from "@plugins/primitives/plugins/css/plugins/text/web";

// Mono log body: intentional fixed code size + line-height (not on the
// typography scale). One spelling for every consumer of this primitive.
const MONO_LOG_CLASS = textVariantClass("code");

/** The app's own log socket. */
const LOGS_WS_PATH = "/ws/logs";

interface LiveLogChannelBaseProps {
  /** Durable channel id to subscribe to (e.g. `deploy`, `release`). */
  channel: string;
  /**
   * Header label. The always-open form appends a dimmed "Live" marker to it,
   * because those surfaces show a live tail BESIDE a persisted one and the two
   * headers have to be told apart. A `disclosure` header does not: its chevron
   * already says whether anything is streaming, and there is no persisted twin
   * beside it to confuse it with.
   */
  label?: ReactNode;
  /** Shown while the buffer is empty (subscribing replays the ring buffer). */
  emptyState?: ReactNode;
  /** Sizing overrides for the scroller (`max-h-*`, `min-h-*`, …). */
  className?: string;
  /**
   * Called with a channel-level error message. The error line is ALWAYS appended
   * to the visible buffer as well — this is the opt-in for consumers that also
   * want a toast, never a way to silence it.
   */
  onError?: (message: string) => void;
}

/**
 * `fill` and `disclosure` are mutually exclusive, and the union is what says so:
 * "take the parent's whole height" and "collapse to a single row" are opposite
 * intents, so a view that can be shut cannot also be the thing filling the box
 * it sits in.
 */
export type LiveLogChannelProps = LiveLogChannelBaseProps &
  (
    | {
        /** Fill the parent's height instead of the default `min-h-48 max-h-96`. */
        fill?: boolean;
        disclosure?: never;
      }
    | {
        fill?: never;
        /**
         * Turn the header into a disclosure control, starting in this state.
         * Omitted ⇒ the view is always open and carries no chevron.
         *
         * Closing it does more than hide: the list is unmounted AND the
         * subscription is dropped, so a shut section costs nothing — this
         * primitive's own "mount it only while visible" rule, made structural
         * instead of merely documented. Reopening resumes from the last sequence
         * already on screen rather than replaying the tail.
         *
         * ONE prop rather than `collapsible` + `defaultOpen`, so "starts open but
         * has no chevron to close it" has no spelling. It is an INITIAL state:
         * changing it later does not reopen a section the reader closed by hand.
         */
        disclosure: "open" | "closed";
      }
  );

/**
 * A live view of one durable log channel: subscribe over `/ws/logs`, replay the
 * ring buffer, append entries as they arrive, stick to the bottom with an
 * off-ramp, and copy the whole buffer.
 *
 * **The one implementation.** This body existed three times (the deploy log
 * panel, the Studio release-log section, the debug log viewer's backend branch),
 * each with its own `lastSeq` de-dup and its own timestamped row markup — three
 * places for the same off-by-one to be wrong in. (The socket-URL derivation they
 * also each repeated now lives in the networking primitive's
 * `useReconnectingWebSocket`, opened at a path on the subtree's transport.)
 *
 * The buffer is per-mount, so **switching channels means remounting**
 * (`<LiveLogChannel key={channel} …/>`): a channel switch must not leave the
 * previous channel's tail on screen, and a `key` makes that structural rather
 * than an effect that has to remember to clear.
 *
 * Mount it only while visible — the subscription is the cost. A surface that
 * wants the section on screen but shut by default says so with `disclosure`,
 * which drops the subscription for exactly as long as the section is closed.
 */
export function LiveLogChannel(props: LiveLogChannelProps): ReactNode {
  // The feed is a per-tab socket opened by URL, which only the page's own
  // server answers: under an in-browser server (the demo) there is no live log
  // to show, and saying so beats opening a socket that would reach the real
  // server's logs instead.
  const { servesUrls } = useTransport();
  if (!servesUrls) {
    return (
      <Text as="div" variant="caption" tone="muted">
        {unavailableMessage({ feature: "Following logs live" })}
      </Text>
    );
  }
  return <LiveLogFeed {...props} />;
}

function LiveLogFeed({
  channel,
  label,
  emptyState,
  fill,
  className,
  onError,
  disclosure,
}: LiveLogChannelProps): ReactNode {
  const [entries, setEntries] = useState<LogEntryWire[]>([]);
  const lastSeqRef = useRef<number>(0);
  // No disclosure ⇒ permanently open, which is what keeps the subscription
  // unconditional for every consumer that does not ask for one.
  const [open, setOpen] = useState(disclosure !== "closed");

  const { scrollRef, bottomSentinel, isFollowing, jumpToBottom } =
    useStickyScroll();

  useReconnectingWebSocket({
    path: LOGS_WS_PATH,
    // The socket IS the cost of the section, so it lives and dies with the
    // section being open.
    enabled: open,
    onOpen: (ws) => {
      const msg: ClientMessage = {
        type: "subscribe",
        channel,
        // Resume rather than replay from zero: a reconnect — or a reopened
        // disclosure — must not duplicate the tail already on screen.
        ...(lastSeqRef.current > 0 && { fromSequence: lastSeqRef.current }),
      };
      ws.send(JSON.stringify(msg));
    },
    onMessage: (event) => {
      const msg: ServerMessage = JSON.parse(event.data);
      switch (msg.type) {
        case "history":
          if (msg.entries.length === 0) break;
          setEntries((prev) => [...prev, ...msg.entries]);
          lastSeqRef.current = Math.max(
            lastSeqRef.current,
            msg.entries[msg.entries.length - 1]!.seq,
          );
          break;
        case "entry":
          if (msg.seq <= lastSeqRef.current) break;
          lastSeqRef.current = msg.seq;
          setEntries((prev) => [...prev, msg]);
          break;
        case "error":
          // Loud in place: the error joins the stream it broke, so a channel
          // that stopped delivering never looks like a channel that went quiet.
          setEntries((prev) => [
            ...prev,
            {
              seq: lastSeqRef.current + 1,
              line: `[error] ${msg.error}`,
              stream: "stderr",
              timestamp: Date.now(),
            },
          ]);
          lastSeqRef.current += 1;
          onError?.(msg.error);
          break;
      }
    },
  });

  const copyText = entries.map((e) => e.line).join("\n");

  const copyButton = (hidden?: boolean) => (
    <ControlSizeProvider size="xs">
      <CopyButton
        text={copyText}
        tooltip="Copy logs"
        // `invisible` is a RESERVATION, not a hide-with-a-dead-target:
        // `visibility: hidden` takes the button out of hit-testing, out of the
        // tab order and out of the a11y tree, while it keeps its box. The box is
        // the point — see the header below.
        className={hidden ? "invisible" : undefined}
      />
    </ControlSizeProvider>
  );

  // Dimmer than the label beside it, and inheriting its size, so it reads as a
  // state marker on the label rather than as a second label.
  const liveMarker = <span className="text-muted-foreground/60">Live</span>;

  const body = (
    <>
      <LogEntryList
        entries={entries}
        emptyState={emptyState}
        fill={fill}
        className={className}
        scrollRef={scrollRef}
        bottomSentinel={bottomSentinel}
      />
      {/* Off-ramp bottom-1 (0.25rem) offset, not on the spacing ramp. */}
      <Pin to="bottom" style={{ bottom: "0.25rem" }}>
        <JumpToBottomButton handle={{ isFollowing, jumpToBottom }} />
      </Pin>
    </>
  );

  const rootClass = fill ? "relative h-full" : "relative";

  if (disclosure === undefined) {
    return (
      <Stack gap="none" className={rootClass}>
        <Line className="pb-xs">
          <Fill>
            <Text as="span" variant="label" tone="muted">
              {label}
              {label ? " " : null}
              {liveMarker}
            </Text>
          </Fill>
          {copyButton()}
        </Line>
        {body}
      </Stack>
    );
  }

  return (
    <CollapsibleProvider open={open} onOpenChange={setOpen}>
      <Stack gap="none" className={rootClass}>
        {/* The header IS the disclosure control, and the copy button rides its
            `actions` slot — a SIBLING of the control, never an interactive
            nested inside one.

            The button is always RENDERED, and merely invisible while the section
            is shut, because a row is as tall as its tallest occupant: a copy
            button that comes and goes took the header from 28px to 36px on every
            toggle, and the chevron and the label visibly slid down with it. So
            the spacer IS the button, exactly as `SectionHeaderRow` already
            reserves the chevron's box on a header that cannot open — a
            hand-measured stand-in would drift from the control it stands in for.
            There is also nothing to copy while shut: the buffer is whatever the
            socket delivered, and the socket is closed. */}
        <SectionHeaderRow actions={copyButton(!open)}>{label}</SectionHeaderRow>
        {/* `rail-x-sm` insets the scroller AND publishes the inset, so the
            bordered log box sits inside the section rather than bleeding to its
            edges the way the header row does. */}
        <CollapsibleContent className="rail-x-sm pb-sm">
          {body}
        </CollapsibleContent>
      </Stack>
    </CollapsibleProvider>
  );
}

export interface LogEntryListProps {
  entries: readonly LogEntryWire[];
  emptyState?: ReactNode;
  fill?: boolean;
  className?: string;
  /** Attach the sticky-scroll handle's scroller ref. */
  scrollRef?: React.Ref<HTMLElement>;
  /** Must be rendered last — it marks the true end of the content. */
  bottomSentinel?: ReactNode;
}

/**
 * The presentational half: a mono, timestamped, stderr-tinted list of log
 * entries in a scroller.
 *
 * Exported separately because one consumer streams a channel this primitive
 * cannot subscribe to (the debug viewer's gateway-sourced SSE channel, which is
 * served by the gateway rather than by `/ws/logs`). It renders the same rows
 * through this component instead of hand-rolling a fourth copy of the markup.
 */
export function LogEntryList({
  entries,
  emptyState,
  fill,
  className,
  scrollRef,
  bottomSentinel,
}: LogEntryListProps): ReactNode {
  return (
    <Scroll
      axis="y"
      fill={fill}
      ref={scrollRef}
      // `cn` (tailwind-merge) last, so a consumer's `max-h-*` really replaces
      // the default instead of tying with it on specificity.
      className={cn(
        "rounded-md border bg-muted/30 px-md py-sm",
        MONO_LOG_CLASS,
        fill ? "h-full" : "min-h-48 max-h-96",
        className,
      )}
    >
      {entries.length === 0 && emptyState !== undefined && (
        <Text as="span" variant="body" tone="muted">
          {emptyState}
        </Text>
      )}
      {entries.map((entry) => (
        <Stack
          key={entry.seq}
          direction="row"
          gap="sm"
          className={
            entry.stream === "stderr" ? "text-destructive" : "text-foreground"
          }
        >
          <span className="text-muted-foreground tabular-nums">
            {new Date(entry.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
            })}
          </span>
          <span className="whitespace-pre-wrap break-all">{entry.line}</span>
        </Stack>
      ))}
      {bottomSentinel}
    </Scroll>
  );
}
