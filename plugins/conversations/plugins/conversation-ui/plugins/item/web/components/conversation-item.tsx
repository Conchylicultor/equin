import {
  cn,
  ControlSizeProvider,
  SingleLineProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type {
  ConversationKind,
  ConversationStatus,
} from "@plugins/tasks/plugins/tasks-core/core";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import {
  Fill,
  fillClasses,
} from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import type { RelativeTimeFormat } from "@plugins/primitives/plugins/relative-time/web";
import { Item } from "../slots";
import { CONV_STATUS_DOT } from "./conv-status-dot";

function ChipsSlot({ conv }: { conv: ConversationItemConv }) {
  const items = Item.Chips.useContributions();
  if (items.length === 0) return null;
  // The chips are a single-line GROUP: a render slot adds no container of its own,
  // so without an explicit nowrap row the chips wrap. <Inline> (a non-wrapping
  // inline-flex row) keeps them on one line — the group-wrap axis is owned by
  // container choice, independent of the per-leaf single-line context.
  return (
    <Inline gap="xs">
      <Item.Chips.Render>
        {(item) => <item.component conv={conv} />}
      </Item.Chips.Render>
    </Inline>
  );
}

// Renders the first Item.Avatar contribution whose `match` predicate returns
// true for this conversation. Falls back to a blank-disc placeholder (via the
// slot's configured fallback) so the title column stays aligned across rows.
function AvatarSlot({ conv }: { conv: ConversationItemConv }) {
  return <Item.Avatar.Dispatch conv={conv} />;
}

// Structural prop type — accepts both the full `Conversation` and the
// narrower `ConversationSummary` carried by the `attempts` set (`attemptRows`). Anything
// with these fields renders. `taskId` is optional because `ConversationSummary`
// doesn't carry it (only the full Conversation row does); contributions that
// need it should bail out when it's undefined.
export type ConversationItemConv = {
  id: string;
  title: string | null;
  status: ConversationStatus;
  kind: ConversationKind;
  createdAt: Date;
  spawnedBy?: string | null;
  taskId?: string | null;
};

export type ConversationItemProps = {
  conv: ConversationItemConv;
  /**
   * - `block` (default): avatar, title row, then a chips + "11m ago" row.
   * - `inline`: one flow line `[avatar] [title] [sys] [chips]`, no time — the chip
   *   shape used mid-sentence.
   * - `line`: one line-container row `[●] [title] [sys] [chips] [11m]` — the
   *   dense list shape (agent-manager sidebar). The status dot sits in a fixed
   *   icon-sized lead box so every title starts on the same column.
   */
  layout?: "block" | "inline" | "line";
  /** Overrides what the row is named by; see {@link ConvTitleOverride}. */
  title?: ConvTitleOverride;
  /**
   * Mutes the title for a reason only the caller knows (e.g. the queue's row
   * whose task is blocked). A `gone` / `done` conversation is muted regardless.
   */
  muted?: boolean;
};

/**
 * A caller-resolved name for the conversation: `label` is shown, `full` is the
 * hover. Absent, the title is {@link conversationTitle} for both.
 */
export type ConvTitleOverride = { label: string; full: string };

export function ConvStatusDot({ conv }: { conv: ConversationItemConv }) {
  return (
    <StatusDot {...CONV_STATUS_DOT[conv.status]} className="inline-block" />
  );
}

export function ConvSysBadge({ conv }: { conv: ConversationItemConv }) {
  if (conv.kind !== "system") return null;
  return <Badge className="text-muted-foreground/80">sys</Badge>;
}

/**
 * What to call this conversation in one line.
 *
 * A conversation takes its task's title when it is created, so an untitled one
 * is rare — but every surface that names one needs the same word for it, as the
 * visible label here and as the hover title of the row / chip / token wrapped
 * around it. Spelled once so those two can never disagree. "Starting…" is a
 * claim about the status, so it is said only while the conversation IS
 * starting; an untitled conversation that is running is just untitled.
 */
export function conversationTitle(conv: ConversationItemConv): string {
  const title = conv.title?.trim();
  if (title) return title;
  return conv.status === "starting" ? "Starting…" : "Untitled";
}

export function ConvTitle({
  conv,
  title,
  variant = "caption",
  muted: mutedByCaller = false,
  className,
}: {
  conv: ConversationItemConv;
  title?: ConvTitleOverride;
  /** See {@link ConversationItemProps.muted}. */
  muted?: boolean;
  /**
   * The title's type role: `caption` (default) where it annotates something
   * larger (a block row, an inline chip), `label` where it IS the row's label
   * (the sidebar `line` layout, beside the nav rows' labels).
   */
  variant?: "caption" | "label";
  className?: string;
}) {
  const muted =
    mutedByCaller || conv.status === "gone" || conv.status === "done";
  // The title is an intrinsically single-line atom — it's used both in the
  // block layout's title row (already a line container) and inside a flow
  // `<Inline>` (the inline conv chip), so it forces single-line itself to
  // ellipsize in both.
  return (
    <SingleLineProvider value={true}>
      <Text
        as="span"
        variant={variant}
        className={cn(className, muted && "text-muted-foreground")}
        title={title?.full}
      >
        {title?.label ?? conversationTitle(conv)}
      </Text>
    </SingleLineProvider>
  );
}

export function ConvRelativeTime({
  conv,
  format,
  className,
}: {
  conv: ConversationItemConv;
  /** Relative-time spelling: `"ago"` (default, "11m ago") or `"short"` ("11m"). */
  format?: RelativeTimeFormat;
  className?: string;
}) {
  const isSystem = conv.kind === "system";
  return (
    <span
      className={cn(
        "text-2xs tabular-nums text-muted-foreground/60",
        className,
      )}
    >
      {isSystem && conv.spawnedBy ? `${conv.spawnedBy} · ` : null}
      <RelativeTime date={conv.createdAt} format={format} />
    </span>
  );
}

export function ConversationItem({
  conv,
  layout = "block",
  title,
  muted,
}: ConversationItemProps) {
  const active = conv.status === "working";
  if (layout === "line") {
    // rigid lead | flexible title | chips + rigid time. The ONE Fill holds the
    // title so it is what truncates; the lead box and the time are rigid, the
    // sys badge and chips never shrink below their own content.
    return (
      // `h-lh`: the row is exactly one text line tall. The chips (a badge, the
      // pie) centre on that line and may bleed into the row's padding, so a row
      // carrying one is as tall as a row without — the list's height estimate.
      <Line className={cn("h-lh w-full gap-sm", active && "opacity-60")}>
        {/* The lead and the title sit on the SIDEBAR NAV's columns: the lead
            box is the nav icon's size and the title follows it by the nav's
            icon gap (sidebar-metrics), so the dot centres under the nav icons
            and the titles start on the nav labels' column. This inner line is
            the row's one flexible cell; the title inside it is what
            truncates. */}
        <Line className={cn("gap-sidebar-icon", fillClasses("x"))}>
          {/* `md`: the dot's own density tier, whatever the list's. */}
          <Center className={cn("size-sidebar-icon", rigidClass())}>
            <ControlSizeProvider size="md">
              <ConvStatusDot conv={conv} />
            </ControlSizeProvider>
          </Center>
          <Fill>
            {/* `sm`: the title's full `label` role even in a compact (`xs`)
                list, which would otherwise drop it to the compact rung — so
                it matches the sidebar nav rows' labels. */}
            <ControlSizeProvider size="sm">
              <ConvTitle
                conv={conv}
                title={title}
                muted={muted}
                variant="label"
              />
            </ControlSizeProvider>
          </Fill>
        </Line>
        {/* Chips hug their content (a flex item never shrinks below it), so
            no wrapper — an empty wrapper would still take a gap. */}
        <ConvSysBadge conv={conv} />
        {/* xs chips: the compact chip rung, matching the short time beside them. */}
        <ControlSizeProvider size="xs">
          <ChipsSlot conv={conv} />
        </ControlSizeProvider>
        <ConvRelativeTime
          conv={conv}
          format="short"
          className={cn("text-faint-foreground", rigidClass())}
        />
      </Line>
    );
  }
  if (layout === "inline") {
    return (
      <Inline gap="xs" className={cn("max-w-full", active && "opacity-60")}>
        <ControlSizeProvider size="xs">
          <AvatarSlot conv={conv} />
        </ControlSizeProvider>
        <ConvTitle conv={conv} title={title} muted={muted} />
        <ConvSysBadge conv={conv} />
        <ChipsSlot conv={conv} />
      </Inline>
    );
  }
  return (
    <Stack
      as={Clip}
      direction="row"
      gap="sm"
      align="start"
      className={cn("w-full", active && "opacity-60")}
    >
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- one-off vertical nudge to baseline-align the avatar with the title row */}
      <span className="mt-0.5">
        <ControlSizeProvider size="sm">
          <AvatarSlot conv={conv} />
        </ControlSizeProvider>
      </span>
      <Stack as={Fill} gap="2xs">
        <Line as={Clip} className="gap-xs">
          <ConvTitle conv={conv} title={title} muted={muted} />
          <ConvSysBadge conv={conv} />
        </Line>
        <Stack direction="row" gap="xs" align="center">
          <ChipsSlot conv={conv} />
          {/* An empty Fill absorbs the slack, so the timestamp sits flush right in its own track. */}
          <Fill />
          <ConvRelativeTime conv={conv} />
        </Stack>
      </Stack>
    </Stack>
  );
}
