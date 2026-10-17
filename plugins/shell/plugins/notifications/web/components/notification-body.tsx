import type { ReactElement } from "react";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { getTabId } from "@plugins/primitives/plugins/scope/plugins/tab-id/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { Notification } from "../../shared/schema";

const VARIANT_TEXT: Record<Notification["variant"], string> = {
  error: "text-destructive",
  warning: "text-warning",
  info: "text-info",
  success: "text-success",
};

const VARIANT_TEXT_MUTED: Record<Notification["variant"], string> = {
  error: "text-destructive/70",
  warning: "text-warning/70",
  info: "text-info/70",
  success: "text-success/70",
};

/** The variant's solid fill — the pane's leading dot. */
export const VARIANT_FILL: Record<Notification["variant"], string> = {
  error: "bg-destructive",
  warning: "bg-warning",
  info: "bg-info",
  success: "bg-success",
};

/**
 * An in-app link only: a row's `linkTo` may be anything the server stored, so
 * anything not starting with `/` opens nothing.
 */
export function notificationLink(n: Notification): string | undefined {
  return n.linkTo?.startsWith("/") ? n.linkTo : undefined;
}

/**
 * One notification's body — title (variant-coloured, a `muted` badge), the
 * description when it says more than the title, and the metadata line (last
 * seen, recurrence count, type, which tab, "View →" for a linked row). Dimmed
 * while read or muted. Shared by the bell popover's row (which adds the accent
 * border, the activation and the dismiss button around it) and the Debug →
 * Notifications pane's list rows (whose row, item actions and activation are
 * the DataView's).
 */
export function NotificationBody({ n }: { n: Notification }): ReactElement {
  const clientId =
    typeof n.metadata?.clientId === "string" ? n.metadata.clientId : null;
  const link = notificationLink(n);
  return (
    <Fill className={cn(n.muted || n.read ? "opacity-60" : undefined)}>
      <Line className="gap-xs">
        <Text
          as="p"
          variant="label"
          className={`truncate ${n.muted ? VARIANT_TEXT_MUTED[n.variant] : VARIANT_TEXT[n.variant]}`}
        >
          {n.title}
        </Text>
        {n.muted && (
          <Badge
            variant="muted"
            tooltip="Low-signal / expected — dimmed, kept out of the unread badge, and never toasted."
          >
            muted
          </Badge>
        )}
      </Line>
      {n.description && n.description !== n.title && (
        <Text
          as="p"
          variant="caption"
          className="text-muted-foreground line-clamp-2"
        >
          {n.description}
        </Text>
      )}
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- small top offset separating the metadata row from the description above */}
      <Stack direction="row" gap="sm" align="center" className="mt-0.5">
        <RelativeTime
          date={n.lastSeenAt}
          className="text-3xs text-muted-foreground"
        />
        {n.count > 1 && (
          <span
            className="text-3xs text-muted-foreground tabular-nums"
            title={`Recurred ${n.count} times — collapsed into one entry`}
          >
            &times;{n.count > 99 ? "99+" : n.count}
          </span>
        )}
        {n.type && (
          <span className="text-3xs text-muted-foreground">{n.type}</span>
        )}
        {clientId != null && (
          <span className="text-3xs text-muted-foreground">
            {clientId === getTabId() ? "this tab" : "another tab"}
          </span>
        )}
        {link !== undefined && (
          <span className="text-3xs text-muted-foreground hover:text-foreground">
            View &rarr;
          </span>
        )}
      </Stack>
    </Fill>
  );
}
