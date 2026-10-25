import {
  ResourceErrorInline,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { useRef, useState } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  Placed,
  pct,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { useAudience } from "@plugins/audience/web";
import { useNotificationArrivals } from "../internal/use-notification-arrivals";
import { useReachingNotifications } from "../internal/use-reaching-notifications";
import { notificationsUnread } from "../../shared/resources";
import { markAllNotificationsRead } from "../../shared/endpoints";
import { NotificationsPanel } from "./notifications-panel";
import { symbol } from "@plugins/ui/plugins/icons/core";

const notificationsIcon = symbol("notifications");

export function BellButton() {
  const fetchEndpoint = useFetchEndpoint();
  const [open, setOpen] = useState(false);
  // The newest 200 undismissed notifications that reach the user's audience
  // (a developer's is the boot-preloaded default window). It drives the toasts
  // and the panel's `empty`; the popover body reads its own queries and mounts
  // only while open.
  const notificationsResult = useReachingNotifications();
  // The badge counts the WHOLE collection (a server-side count), not the loaded
  // window — an unread error older than the newest 200 still turns it red. One
  // count per audience: the bell reads its user's.
  const unreadResult = useLive(notificationsUnread);
  const audience = useAudience();

  // A toast for each notification that arrives while the bell is mounted.
  useNotificationArrivals((n) =>
    showToast({
      title: n.title,
      description: n.description,
      variant: n.variant,
      audience: n.audience,
    }),
  );

  const hadUnreadRef = useRef(false);

  // Gate at the render boundary — prevents the badge from flashing 0→N while
  // either read loads (both are boot-preloaded, so this is normally never hit).
  // Render a neutral bell (no badge) during the load window, and the error
  // bell (click retries) when either read failed — never the neutral one, which
  // would claim "nothing unread" about a count nobody could read.
  const both = useCombinedResources({
    list: notificationsResult,
    unread: unreadResult,
    audience,
  });
  if (both.status === "loading") {
    return (
      <span className="relative inline-block">
        <IconButton
          icon={notificationsIcon}
          label="Notifications"
          className="text-muted-foreground"
        />
      </span>
    );
  }
  if (both.status === "error") {
    return (
      <span className="relative inline-block">
        <ResourceErrorInline
          variant="icon"
          icon={notificationsIcon}
          subject="notifications"
          error={both.error}
          refetch={both.refetch}
        />
      </span>
    );
  }

  const { list } = both.data;
  const { errors, warnings } = both.data.unread[both.data.audience];
  const unreadCount = errors + warnings;
  // Match the badge color to the most severe unread item: red only when a crash
  // (error) is present, otherwise amber for warning-only noise (e.g. slow ops).
  // Both wear the SOLID fills (a deep oxblood / deep amber with light figures in
  // the chrome theme), not `destructive` / `warning`, which the chrome keeps
  // bright for text.
  const badgeColor =
    errors > 0
      ? "bg-destructive-solid text-destructive-solid-foreground"
      : "bg-warning-solid text-warning-solid-foreground";

  function onOpenChange(next: boolean) {
    if (next) {
      hadUnreadRef.current = unreadCount > 0;
    } else if (hadUnreadRef.current) {
      void fetchEndpoint(markAllNotificationsRead, {});
      hadUnreadRef.current = false;
    }
    setOpen(next);
  }

  return (
    <InlinePopover
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <span className="relative inline-block">
          <IconButton
            // Always the outline bell: the badge says there is something
            // unread, so the glyph does not fill as well.
            icon={notificationsIcon}
            // The exact count: the visible badge caps at "9+".
            label={
              unreadCount > 0
                ? `Notifications, ${unreadCount} unread`
                : "Notifications"
            }
          />
          {unreadCount > 0 && (
            // Hangs off the glyph's top-right corner rather than covering it:
            // its top-left sits 2/32 down and 17/32 across the button, as a
            // fraction so it lands the same at every control height (the
            // docked sm strip and the floating md capsule). The 2px ring in
            // the surface's own ground cuts it out of the bell.
            <Placed
              x={{ start: pct(17 / 32) }}
              y={{ start: pct(2 / 32) }}
              layer="raised"
              decorative
            >
              <Center
                // A 16px pill: as wide as tall for one figure, growing with
                // 4px either side for "9+" rather than squeezing it. Its
                // figures are the count-chip role (`tag-compact`, strong).
                className={`h-4 min-w-4 rounded-full px-xs ring-2 ring-chrome-mask ${badgeColor} text-tag-compact font-tag-strong tabular-nums`}
              >
                {unreadCount > 9 ? "9+" : unreadCount}
              </Center>
            </Placed>
          )}
        </span>
      }
      align="end"
      width="xl"
      padding="none"
    >
      {open && (
        <NotificationsPanel
          empty={list.length === 0}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </InlinePopover>
  );
}
