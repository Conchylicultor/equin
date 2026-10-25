import { useAudience } from "@plugins/audience/web";
import {
  type LiveCollection,
  type LiveWhereObject,
} from "@plugins/network/plugins/live/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { notifications } from "../../shared/resources";
import { audienceScope } from "../../shared/audience-scope";

type NotificationsFilterable =
  typeof notifications extends LiveCollection<infer _R, infer F, infer _S>
    ? F
    : never;

/** A bell read's own filter, ANDed with the audience scope. */
export type NotificationsWhere = LiveWhereObject<NotificationsFilterable>;

// While the audience is not known yet, the read runs unscoped (a developer's —
// the boot-preloaded default window) and the caller sees the audience's own
// loading / error arm instead: what the bell shows depends on it.
function useScopedWhere(where: NotificationsWhere | undefined) {
  const audience = useAudience();
  const scope = audience.status === "ready" ? audienceScope(audience.data) : {};
  const scoped = { ...scope, ...where };
  const gate =
    audience.status === "loading"
      ? { status: "loading" as const, refetch: audience.refetch }
      : audience.status === "error"
        ? {
            status: "error" as const,
            error: audience.error,
            refetch: audience.refetch,
          }
        : null;
  return {
    where: Object.keys(scoped).length === 0 ? undefined : scoped,
    gate,
  };
}

/**
 * The notifications window the reader's audience may see — every bell list
 * read goes through here, so a user not in Developer mode never sees (nor is
 * toasted) a notification declared for developers, nor a muted one.
 */
export function useReachingNotifications(where?: NotificationsWhere) {
  const { where: scoped, gate } = useScopedWhere(where);
  const result = useLive(
    notifications,
    scoped === undefined ? undefined : { where: scoped },
  );
  return gate ?? result;
}

/** {@link useReachingNotifications}, as a grouping on one column. */
export function useReachingNotificationGroups<G extends "type" | "variant">(
  groupBy: G,
) {
  const { where, gate } = useScopedWhere(undefined);
  const result = useLive(
    notifications,
    where === undefined ? { groupBy } : { groupBy, where },
  );
  return gate ?? result;
}
