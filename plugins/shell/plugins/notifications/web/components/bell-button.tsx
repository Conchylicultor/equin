import {
  ResourceErrorInline,
  useCombinedResources,
} from "@plugins/primitives/plugins/live-state/web";
import { useEffect, useRef, useState } from "react";
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
import { recentClientIds } from "../internal/toast";
import { notifications, notificationsUnread } from "../../shared/resources";
import { markAllNotificationsRead } from "../../shared/endpoints";
import { NotificationsPanel } from "./notifications-panel";
import { symbol } from "@plugins/ui/plugins/icons/core";

const notificationsIcon = symbol("notifications");

export function BellButton() {
  const fetchEndpoint = useFetchEndpoint();
  const [open, setOpen] = useState(false);
  // The default window (newest 200 undismissed) — boot-preloaded, so the bell
  // paints settled. It drives the toasts and the panel's `empty`; the popover
  // body reads its own queries and mounts only while open.
  const notificationsResult = useLive(notifications);
  // The badge counts the WHOLE collection (a server-side count), not the loaded
  // window — an unread error older than the newest 200 still turns it red.
  const unreadResult = useLive(notificationsUnread);

  // prevIdsRef must always run — it tracks new-notification arrivals for toasts.
  const prevIdsRef = useRef<Set<string> | null>(null);

  // Effect: fire toasts for newly arrived notifications. Reads notificationsResult
  // directly and narrows inside so we never capture a stale unsettled snapshot.
  useEffect(() => {
    if (
      notificationsResult.status === "loading" ||
      notificationsResult.status === "error"
    ) {
      return;
    }
    const settled = notificationsResult.data;
    const currentIds = new Set(settled.map((n) => n.id));
    if (prevIdsRef.current !== null) {
      for (const n of settled) {
        if (
          !prevIdsRef.current.has(n.id) &&
          !recentClientIds.has(n.id) &&
          !n.muted
        ) {
          showToast({
            title: n.title,
            description: n.description,
            variant: n.variant,
          });
        }
      }
    }
    prevIdsRef.current = currentIds;
    // notificationsResult identity changes on every push; depend on the result object
  }, [notificationsResult]);

  const hadUnreadRef = useRef(false);

  // Gate at the render boundary — prevents the badge from flashing 0→N while
  // either read loads (both are boot-preloaded, so this is normally never hit).
  // Render a neutral bell (no badge) during the load window, and the error
  // bell (click retries) when either read failed — never the neutral one, which
  // would claim "nothing unread" about a count nobody could read.
  const both = useCombinedResources({
    list: notificationsResult,
    unread: unreadResult,
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
  const { errors, warnings } = both.data.unread;
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
