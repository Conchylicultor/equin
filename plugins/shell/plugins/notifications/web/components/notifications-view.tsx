import type { ReactElement } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { appLink } from "@plugins/apps-core/plugins/tabs/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import {
  DataView,
  defineDataView,
  defineItemActions,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  FieldDef,
  ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { navIcons, symbol } from "@plugins/ui/plugins/icons/core";
import { notifications } from "../../shared/resources";
import {
  dismissAllNotifications,
  dismissNotification,
  markAllNotificationsRead,
} from "../../shared/endpoints";
import type { Notification } from "../../shared/schema";
import {
  NotificationBody,
  VARIANT_FILL,
  notificationLink,
} from "./notification-body";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
// Its views are authored in `config/shell/notifications/shell.notifications.jsonc`.
const NOTIFICATIONS_VIEW = defineDataView("shell.notifications");

// Every undismissed notification, as live key-range pages of the same
// collection the bell reads (its `dismissed = false` base membership is the
// server's). Search matches the title; `type` / `variant` are facets — their
// options are read live as groupings of the whole collection, so a type seen
// only in old rows is still offered.
export const notificationsSource = liveDataSource(notifications, {
  searchable: ["title"],
  facets: ["type", "variant"],
});

const dismissIcon = symbol("close");

/** The pane's per-row actions — Dismiss, and Open for a row with an in-app link. */
export const NotificationItemActions = defineItemActions<Notification>();

/** Dismiss one notification: it leaves the collection (a membership exit), so the row leaves live. */
export function DismissNotificationAction({
  row,
}: ItemActionProps<Notification>): ReactElement {
  const dismiss = useEndpointMutation(dismissNotification);
  return (
    <IconButton
      icon={dismissIcon}
      label="Dismiss"
      onClick={() => {
        dismiss.mutate({ params: { id: row.id } });
      }}
    />
  );
}

/** Open the row's in-app link (a link: ⌘ / middle-click open a browser tab). */
export function OpenNotificationAction({
  row,
}: ItemActionProps<Notification>): ReactElement | null {
  const link = notificationLink(row);
  if (link === undefined) return null;
  return (
    <IconButton
      icon={navIcons.expand}
      label="Open"
      {...activationProps(appLink(link))}
    />
  );
}

/**
 * Debug → Notifications: the whole undismissed collection as a DataView — the
 * bell popover's "View all". The authored view groups on `read` (server
 * sections: unread first, each with its exact count) newest first. The rows
 * are the popover's own body; the toolbar marks everything read or clears it.
 */
export function NotificationsView(): ReactElement {
  return (
    <DataView<Notification>
      storageKey={NOTIFICATIONS_VIEW}
      fields={fields}
      views={["list"]}
      source={notificationsSource}
      searchPlaceholder="Search notifications…"
      viewOptions={{
        list: {
          // The variant as a dot — the popover's accent border, in the list's
          // own leading slot (the title wears the variant's colour too).
          leading: (n: Notification) => (
            <StatusDot colorClass={VARIANT_FILL[n.variant]} />
          ),
          renderRow: (n: Notification) => <NotificationBody n={n} />,
        },
      }}
      rowActivation={(n) => {
        const link = notificationLink(n);
        return link === undefined ? undefined : appLink(link);
      }}
      itemActions={NotificationItemActions}
      actions={<BulkActions />}
      emptyState={<>No notifications.</>}
    />
  );
}

/** The toolbar's bulk actions, over the WHOLE collection (the existing endpoints). */
function BulkActions(): ReactElement {
  const markAllRead = useEndpointMutation(markAllNotificationsRead);
  const dismissAll = useEndpointMutation(dismissAllNotifications);
  return (
    <Inline gap="xs">
      <Button
        variant="ghost"
        loading={markAllRead.isPending}
        onClick={() => {
          markAllRead.mutate({});
        }}
      >
        Mark all read
      </Button>
      <Button
        variant="ghost"
        loading={dismissAll.isPending}
        onClick={() => {
          dismissAll.mutate({});
        }}
      >
        Clear all
      </Button>
    </Inline>
  );
}

// Static: nothing derives from the loaded rows. Every field reads its own
// column of the `notifications` collection (same-name binding); `type` and
// `variant` declare no `options` — their option lists are the source's facets.
// The rows draw through `renderRow`, so these are the Sort / Filter / Group-by
// vocabulary — the config is written against these ids.
export const fields: FieldDef<Notification>[] = [
  {
    id: "title",
    label: "Title",
    type: "text",
    value: (n) => n.title,
    primary: true,
    sortable: false,
    filterable: true,
  },
  {
    id: "type",
    label: "Type",
    type: "enum",
    value: (n) => n.type,
    sortable: false,
    filterable: true,
  },
  {
    id: "variant",
    label: "Variant",
    type: "enum",
    value: (n) => n.variant,
    sortable: false,
    filterable: true,
  },
  {
    // The raw `read` column — not the badge's "counted unread", which also
    // requires an unmuted error or warning: an unread info row is unread here.
    id: "read",
    label: "Read",
    type: "bool",
    value: (n) => n.read,
    // The pane's sections: "Unread" first, then "Read" — not the bool's Yes / No.
    options: [
      { value: "false", label: "Unread" },
      { value: "true", label: "Read" },
    ],
    sortable: false,
    filterable: true,
  },
  {
    id: "muted",
    label: "Muted",
    type: "bool",
    value: (n) => n.muted,
    sortable: false,
    filterable: true,
  },
  {
    id: "createdAt",
    label: "Surfaced",
    type: "date",
    value: (n) => n.createdAt,
    sortable: true,
    filterable: false,
    visible: false,
  },
];
