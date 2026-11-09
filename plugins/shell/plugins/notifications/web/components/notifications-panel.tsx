import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useState } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { useAppLink } from "@plugins/apps-core/plugins/tabs/web";
import { afterOpen } from "@plugins/primitives/plugins/link-gesture/core";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  InfiniteScrollFooter,
  useInfiniteScroll,
} from "@plugins/primitives/plugins/cursor-pagination/web";
import type { Notification } from "../../shared/resources";
import {
  useReachingNotificationGroups,
  useReachingNotifications,
  type NotificationsWhere,
} from "../internal/use-reaching-notifications";
import { markAllNotificationsRead } from "../../shared/endpoints";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_LABELS,
  NOTIFICATION_NO_STATE_LABEL,
  NOTIFICATION_STATE_TONES,
  NOTIFICATION_STATE_TONE_LABELS,
  notificationsRoute,
  type NotificationCategory,
  type NotificationStateTone,
} from "../../core";
import { NotificationView } from "./notification-view";

const markAllReadIcon = symbol("done-all");

/**
 * The popover's row: the shared view (the toast's own) with its time and the
 * unread dot. Opening it — the row itself, or its action — closes the popover.
 */
function NotificationRow({
  n,
  onClose,
}: {
  n: Notification;
  onClose: () => void;
}) {
  return (
    <li>
      <NotificationView
        n={n}
        surface="bell"
        when={n.createdAt}
        unread={!n.read}
        onActed={onClose}
        className="rounded-control py-sm pl-md pr-sm hover:bg-hover-fill"
      />
    </li>
  );
}

/**
 * Where a category's rows stand: a state tone, or `open` — no state recorded,
 * so nothing has resolved it yet.
 */
type Standing = NotificationStateTone | "open";

/** Which slice of the collection the list shows. */
type Filter =
  | { kind: "all" }
  | { kind: "errors" }
  | {
      kind: "category";
      category: NotificationCategory;
      /** Narrowed to one standing (the state chips), or every row of it. */
      standing: Standing | null;
    };

/** The server-side `where` of a filter's list. */
function whereOf(filter: Filter): NotificationsWhere | undefined {
  switch (filter.kind) {
    case "all":
      return undefined;
    case "errors":
      return { variant: "error" };
    case "category":
      return {
        category: filter.category,
        ...(filter.standing === "open"
          ? { stateTone: { isEmpty: true } }
          : filter.standing !== null
            ? { stateTone: filter.standing }
            : {}),
      };
  }
}

/** Always offered, even at 0: the user's own vocabulary for the bell. */
const PRIMARY_CATEGORIES: readonly NotificationCategory[] = [
  "conversations",
  "updates",
  "automations",
];

function Chip({
  active,
  onPick,
  label,
  count,
  hot = false,
  category,
}: {
  active: boolean;
  onPick: () => void;
  label: string;
  count?: number;
  hot?: boolean;
  category?: NotificationCategory;
}) {
  return (
    <ToggleChip
      variant="ghost"
      active={active}
      onClick={onPick}
      data-category={category}
      // eslint-disable-next-line layout/no-adhoc-layout -- rigid chip in the horizontally-scrolling filter row
      className="shrink-0"
    >
      {label}
      {count !== undefined && (
        <>
          {" "}
          <Text
            variant="caption"
            tone={hot && count > 0 ? "destructive" : "faint"}
            className="tabular-nums"
          >
            {count}
          </Text>
        </>
      )}
    </ToggleChip>
  );
}

/**
 * The chip strip: All · Errors · Conversations · Updates · Automations, plus
 * Reports / Other only while they hold anything. Counts come from the
 * SERVER's grouping of the whole collection — never from the rows loaded — so
 * a category that appears only in older rows still counts. While the groups
 * load the strip shows a loading state, never zeros.
 */
function FilterChips({
  filter,
  onPick,
}: {
  filter: Filter;
  onPick: (next: Filter) => void;
}) {
  const categories = useReachingNotificationGroups("category");
  const variants = useReachingNotificationGroups("variant");

  // Precedence error > loading: one failed read fails the row, even while
  // the other still loads.
  if (categories.status === "error" || variants.status === "error") {
    const failed = categories.status === "error" ? categories : variants;
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
  if (categories.status === "loading" || variants.status === "loading") {
    return (
      <div className="px-md py-xs border-b" data-testid="notification-chips">
        <Loading label="Loading filters…" />
      </div>
    );
  }

  const countOf = (category: NotificationCategory) =>
    categories.data.find((g) => g.value === category)?.count ?? 0;
  const errors = variants.data.find((g) => g.value === "error")?.count ?? 0;
  const shown = NOTIFICATION_CATEGORIES.filter(
    (c) => PRIMARY_CATEGORIES.includes(c) || countOf(c) > 0,
  );

  return (
    <Scroll
      axis="x"
      hideScrollbar
      className="px-sm pb-sm border-b"
      data-testid="notification-chips"
    >
      {/* Compact chips: the five user categories fit the 320px popover. */}
      <ControlSizeProvider size="xs">
        <Stack direction="row" gap="2xs">
          <Chip
            label="All"
            active={filter.kind === "all"}
            onPick={() => {
              onPick({ kind: "all" });
            }}
          />
          <Chip
            label="Errors"
            count={errors}
            hot
            active={filter.kind === "errors"}
            onPick={() => {
              onPick({ kind: "errors" });
            }}
          />
          {shown.map((c) => (
            <Chip
              key={c}
              label={NOTIFICATION_CATEGORY_LABELS[c]}
              count={countOf(c)}
              category={c}
              active={filter.kind === "category" && filter.category === c}
              onPick={() => {
                onPick({ kind: "category", category: c, standing: null });
              }}
            />
          ))}
        </Stack>
      </ControlSizeProvider>
    </Scroll>
  );
}

/**
 * The picked category's rows by where their problem stands — Open · Pending ·
 * Resolved · Came back — when any of them carries a state (a report's fix
 * ledger restates its rows in place). The list is newest first, and a
 * resolved problem stops recurring, so its rows sink below everything still
 * firing: without this slice a fix is in the bell but out of sight. Counts are
 * the server's grouping of the whole category, never of the loaded rows.
 */
function StateChips({
  filter,
  onPick,
}: {
  filter: Extract<Filter, { kind: "category" }>;
  onPick: (next: Filter) => void;
}) {
  const groups = useReachingNotificationGroups("stateTone", {
    category: filter.category,
  });
  if (groups.status === "error") {
    return (
      <div className="px-md py-xs border-b" data-testid="notification-states">
        <ResourceErrorInline
          variant="inline"
          subject="states"
          error={groups.error}
          refetch={groups.refetch}
        />
      </div>
    );
  }
  if (groups.status === "loading") {
    return (
      <div className="px-md py-xs border-b" data-testid="notification-states">
        <Loading label="Loading states…" />
      </div>
    );
  }
  const countOf = (standing: Standing) =>
    groups.data.find((g) =>
      standing === "open" ? g.value === null : g.value === standing,
    )?.count ?? 0;
  // A category none of whose rows carries a state has nothing to split.
  if (!NOTIFICATION_STATE_TONES.some((t) => countOf(t) > 0)) return null;
  const pick = (standing: Standing | null) => {
    onPick({ ...filter, standing });
  };

  return (
    <Scroll
      axis="x"
      hideScrollbar
      className="px-sm py-xs border-b"
      data-testid="notification-states"
    >
      <ControlSizeProvider size="xs">
        <Stack direction="row" gap="2xs">
          <Chip
            label="Any state"
            active={filter.standing === null}
            onPick={() => {
              pick(null);
            }}
          />
          <Chip
            label={NOTIFICATION_NO_STATE_LABEL}
            count={countOf("open")}
            active={filter.standing === "open"}
            onPick={() => {
              pick("open");
            }}
          />
          {NOTIFICATION_STATE_TONES.map((tone) => (
            <Chip
              key={tone}
              label={NOTIFICATION_STATE_TONE_LABELS[tone]}
              count={countOf(tone)}
              hot={tone === "recurred"}
              active={filter.standing === tone}
              onPick={() => {
                pick(tone);
              }}
            />
          ))}
        </Stack>
      </ControlSizeProvider>
    </Scroll>
  );
}

/** Local midnight today — rows from before it are "Earlier". */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function Section({
  title,
  rows,
  onClose,
}: {
  title: string;
  rows: Notification[];
  onClose: () => void;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <Inset x="md" t="sm" b="2xs">
        <Text variant="group" tone="faint">
          {title}
        </Text>
      </Inset>
      <Stack as="ul" gap="none" className="px-xs">
        {rows.map((n) => (
          <NotificationRow key={n.id} n={n} onClose={onClose} />
        ))}
      </Stack>
    </>
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
  const result = useReachingNotifications(whereOf(filter));
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

  const today = startOfToday();
  const todays = rows.filter((n) => n.createdAt >= today);
  const earlier = rows.filter((n) => n.createdAt < today);

  return (
    <Scroll className="max-h-120 pb-xs" data-testid="notification-list">
      <Section title="Today" rows={todays} onClose={onClose} />
      <Section title="Earlier" rows={earlier} onClose={onClose} />
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
  const inAppLink = useAppLink();
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const markAllRead = useEndpointMutation(markAllNotificationsRead);

  return (
    <>
      <Line className="gap-xs pl-md pr-sm pt-sm pb-xs">
        <Fill>
          <Text variant="body" tone="strong" className="font-semibold">
            Notifications
          </Text>
        </Fill>
        {!empty && (
          <IconButton
            icon={markAllReadIcon}
            label="Mark all read"
            onClick={() => {
              markAllRead.mutate({});
            }}
          />
        )}
        {/* The whole collection as a DataView (Debug → Notifications). It
            leaves through `onClose` — the same way an action does — which
            closes the popover WITHOUT the bell's mark-all-read: that runs only
            on the popover's own dismissal (`onOpenChange`), and the pane
            offers its own "Mark all read". */}
        <Text
          as="button"
          variant="caption"
          className="rounded-control px-xs py-2xs text-muted-foreground hover:bg-hover-fill hover:text-foreground"
          {...activationProps(
            afterOpen(
              inAppLink(notificationsRoute.link(debugApp, {})),
              onClose,
            ),
          )}
        >
          View all
        </Text>
      </Line>
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
          {filter.kind === "category" && (
            <StateChips filter={filter} onPick={setFilter} />
          )}
          <NotificationList filter={filter} onClose={onClose} />
        </>
      )}
    </>
  );
}
