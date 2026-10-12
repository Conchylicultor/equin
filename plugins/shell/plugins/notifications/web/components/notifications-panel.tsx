import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useState } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { matchesFilter } from "@plugins/network/plugins/live/plugins/filter/core";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { getTabId } from "@plugins/primitives/plugins/scope/plugins/tab-id/web";
import { appLink } from "@plugins/apps-core/plugins/tabs/web";
import { afterOpen } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  InfiniteScrollFooter,
  useInfiniteScroll,
} from "@plugins/primitives/plugins/cursor-pagination/web";
import { notifications } from "../../shared/resources";
import { countedUnread, countedUnreadFilterable } from "../../shared/unread";
import {
  dismissNotification,
  dismissAllNotifications,
} from "../../shared/endpoints";
import type { Notification } from "../../shared/schema";

const VARIANT_BORDER: Record<Notification["variant"], string> = {
  error: "border-l-destructive",
  warning: "border-l-warning",
  info: "border-l-info",
  success: "border-l-success",
};

const VARIANT_TEXT: Record<Notification["variant"], string> = {
  error: "text-destructive",
  warning: "text-warning",
  info: "text-info",
  success: "text-success",
};

const VARIANT_BORDER_MUTED: Record<Notification["variant"], string> = {
  error: "border-l-destructive/40",
  warning: "border-l-warning/40",
  info: "border-l-info/40",
  success: "border-l-success/40",
};

const VARIANT_TEXT_MUTED: Record<Notification["variant"], string> = {
  error: "text-destructive/70",
  warning: "text-warning/70",
  info: "text-info/70",
  success: "text-success/70",
};

function NotificationRow({
  n,
  dismiss,
  onClose,
}: {
  n: Notification;
  dismiss: (id: string) => void;
  onClose: () => void;
}) {
  const clientId =
    typeof n.metadata?.clientId === "string" ? n.metadata.clientId : null;
  // An in-app link only: a row's `linkTo` may be anything the server stored.
  const link = n.linkTo?.startsWith("/") ? n.linkTo : undefined;
  return (
    <Stack
      as="li"
      direction="row"
      gap="sm"
      className={`px-md py-sm border-l-2 ${n.muted ? VARIANT_BORDER_MUTED[n.variant] : VARIANT_BORDER[n.variant]} ${n.muted || n.read ? "opacity-60" : ""} hover:bg-muted/50 ${link !== undefined ? "cursor-pointer" : ""}`}
      {...activationProps(
        link !== undefined ? afterOpen(appLink(link), onClose) : undefined,
      )}
    >
      <Fill>
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
              title="Low-signal / expected — dimmed, kept out of the unread badge, and never toasted."
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
      <Text
        as="button"
        variant="body"
        // eslint-disable-next-line text/no-adhoc-typography -- tight line-height centers the × glyph in the button
        className={cn(
          rigidClass(),
          "text-muted-foreground hover:text-foreground leading-none",
        )}
        onClick={(e) => {
          e.stopPropagation();
          dismiss(n.id);
        }}
        aria-label="Dismiss"
      >
        &times;
      </Text>
    </Stack>
  );
}

/** Which slice of the collection the list shows. */
type Filter =
  { kind: "all" } | { kind: "errors" } | { kind: "type"; type: string };

const isCountedUnread = (n: Notification) =>
  matchesFilter(n, countedUnread, countedUnreadFilterable);

const chipLabel = (type: string) =>
  type.charAt(0).toUpperCase() + type.slice(1);

/**
 * The chip strip. Chips come from the SERVER's grouping of the whole collection
 * — never from the rows loaded — so a type that appears only in older rows still
 * has one. While the groups load the strip shows a loading state, never an empty
 * row; a "More" chip pages through further types while there are any.
 */
function FilterChips({
  filter,
  onPick,
}: {
  filter: Filter;
  onPick: (next: Filter) => void;
}) {
  const types = useLive(notifications, { groupBy: "type" });
  const variants = useLive(notifications, { groupBy: "variant" });

  // Precedence error > loading: one failed read fails the row, even while
  // the other still loads.
  if (types.status === "error" || variants.status === "error") {
    const failed = types.status === "error" ? types : variants;
    return (
      <div className="px-md py-xs border-b" data-testid="notification-chips">
        {failed.status === "error" && (
          <ResourceErrorInline
            variant="inline"
            subject="filters"
            error={failed.error}
            refetch={failed.refetch}
          />
        )}
      </div>
    );
  }
  if (types.status === "loading" || variants.status === "loading") {
    return (
      <div className="px-md py-xs border-b" data-testid="notification-chips">
        <Loading label="Loading filters…" />
      </div>
    );
  }

  const hasErrors = variants.data.some((g) => g.value === "error");
  const typeChips = types.data.filter(
    (g): g is { value: string; count: number } => !!g.value,
  );

  return (
    <Scroll
      axis="x"
      className="px-md py-xs border-b"
      data-testid="notification-chips"
    >
      <Stack direction="row" gap="xs">
        <ToggleChip
          variant="ghost"
          active={filter.kind === "all"}
          onClick={() => {
            onPick({ kind: "all" });
          }}
          // eslint-disable-next-line layout/no-adhoc-layout -- rigid chip in the horizontally-scrolling filter row
          className="shrink-0"
        >
          All
        </ToggleChip>
        {hasErrors && (
          <ToggleChip
            variant="ghost"
            active={filter.kind === "errors"}
            onClick={() => {
              onPick({ kind: "errors" });
            }}
            // eslint-disable-next-line layout/no-adhoc-layout -- rigid chip in the horizontally-scrolling filter row
            className="shrink-0"
          >
            Errors
          </ToggleChip>
        )}
        {typeChips.map((g) => (
          <ToggleChip
            key={g.value}
            variant="ghost"
            active={filter.kind === "type" && filter.type === g.value}
            onClick={() => {
              onPick({ kind: "type", type: g.value });
            }}
            title={`${g.count} ${g.value} notification${g.count === 1 ? "" : "s"}`}
            data-type={g.value}
            // eslint-disable-next-line layout/no-adhoc-layout -- rigid chip in the horizontally-scrolling filter row
            className="shrink-0"
          >
            {chipLabel(g.value)}{" "}
            <span className="text-muted-foreground tabular-nums">
              {g.count}
            </span>
          </ToggleChip>
        ))}
        {(types.canGrow || types.growing) && (
          <ToggleChip
            variant="ghost"
            active={false}
            disabled={types.growing}
            onClick={types.loadMore}
            // eslint-disable-next-line layout/no-adhoc-layout -- rigid chip in the horizontally-scrolling filter row
            className="shrink-0"
          >
            {types.growing ? "Loading…" : "More"}
          </ToggleChip>
        )}
      </Stack>
    </Scroll>
  );
}

/**
 * The list for the picked filter. "All" is the default window — the same tuple
 * the bell itself reads, so it adds no subscription; a chip reads a server-side
 * filtered window. A pending filtered window shows a loading state in the list
 * area only (the header and chips stay), and the list grows by infinite scroll.
 */
function NotificationList({
  filter,
  onClose,
}: {
  filter: Filter;
  onClose: () => void;
}) {
  const result = useLive(
    notifications,
    filter.kind === "all"
      ? undefined
      : filter.kind === "errors"
        ? { where: { variant: "error" } }
        : { where: { type: filter.type } },
  );
  // Only a ready window has paging handles; the arms below render the rest.
  const settled =
    result.status === "loading" || result.status === "error" ? null : result;
  const scroll = useInfiniteScroll({
    hasNextPage: settled?.canGrow ?? false,
    isFetchingNextPage: settled?.growing ?? false,
    isFetchNextPageError: false,
    fetchNextPage: () => {
      settled?.loadMore();
    },
    rootMargin: "200px",
  });
  const dismissOne = useEndpointMutation(dismissNotification);

  if (result.status === "loading") return <Loading variant="rows" count={4} />;
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="notifications"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }

  const rows = result.data;
  if (rows.length === 0) {
    return (
      <Text
        as="p"
        variant="body"
        className="px-md py-xl text-center text-muted-foreground"
      >
        No notifications for this filter
      </Text>
    );
  }

  function dismiss(id: string) {
    dismissOne.mutate({ params: { id } });
  }

  const unread = rows.filter(isCountedUnread);
  const rest = rows.filter((n) => !isCountedUnread(n));
  // Match the header color to the most severe unread item shown.
  const hasUnreadError = unread.some((n) => n.variant === "error");

  return (
    <Scroll className="max-h-96" data-testid="notification-list">
      {unread.length > 0 && (
        <>
          <div
            className={`px-md py-xs text-3xs font-semibold uppercase tracking-wider border-b ${hasUnreadError ? "text-destructive bg-destructive/5" : "text-warning bg-warning/5"}`}
          >
            Unread ({unread.length})
          </div>
          <ul>
            {unread.map((n) => (
              <NotificationRow
                key={n.id}
                n={n}
                dismiss={dismiss}
                onClose={onClose}
              />
            ))}
          </ul>
        </>
      )}
      {rest.length > 0 && (
        <>
          {unread.length > 0 && (
            <div className="px-md py-xs text-3xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-t">
              Earlier
            </div>
          )}
          <ul>
            {rest.map((n) => (
              <NotificationRow
                key={n.id}
                n={n}
                dismiss={dismiss}
                onClose={onClose}
              />
            ))}
          </ul>
        </>
      )}
      <InfiniteScrollFooter handle={scroll} />
    </Scroll>
  );
}

/**
 * The popover body, mounted only while the popover is open — so the grouping
 * and filtered-window subscriptions exist only while someone is looking.
 * `empty` is the bell's default window being empty: the collection itself has
 * no rows, so there is nothing to filter.
 */
export function NotificationsPanel({
  empty,
  onClose,
}: {
  empty: boolean;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const dismissAll = useEndpointMutation(dismissAllNotifications);

  return (
    <>
      <Stack
        direction="row"
        gap="sm"
        align="center"
        justify="between"
        className="px-md py-sm border-b"
      >
        <Text variant="body" className="font-semibold">
          Notifications
        </Text>
        {!empty && (
          <Text
            as="button"
            variant="caption"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => {
              dismissAll.mutate({});
            }}
          >
            Clear all
          </Text>
        )}
      </Stack>
      {empty ? (
        <Text
          as="p"
          variant="body"
          className="px-md py-xl text-center text-muted-foreground"
        >
          No notifications
        </Text>
      ) : (
        <>
          <FilterChips filter={filter} onPick={setFilter} />
          <NotificationList filter={filter} onClose={onClose} />
        </>
      )}
    </>
  );
}
