import { useCallback } from "react";
import type { Audience } from "@plugins/audience/core";
import {
  useFetchEndpoint,
  useMachineAvailability,
} from "@plugins/infra/plugins/endpoints/web";
import { createNotification } from "../../shared/endpoints";
import type { NotificationVariant } from "../../shared/schema";
import {
  notificationIdKind,
  type NotificationAction,
  type NotificationCategory,
} from "../../core";
import { getTabId } from "@plugins/primitives/plugins/scope/plugins/tab-id/web";
import type { SymbolRef } from "@plugins/ui/plugins/icons/core";
import {
  useToastNotification,
  type LiveToastAction,
  type NotificationToastKind,
} from "../components/notification-view";

/**
 * A toast — every toast the app raises. It is shown at once AND recorded in
 * the notification history (the bell), so a toast the user had no time to
 * read is still there; `category` files it under the bell's chips (small
 * acknowledgements — Copied, Deleted, Restored — under `confirmations`).
 */
export type ToastArgs = ToastFields &
  (
    | {
        /** The one action (`Notifications.Action` kind + payload), stored. */
        action?: NotificationAction;
        liveAction?: never;
      }
    | {
        action?: never;
        /**
         * A closure action (Undo) or a link built by the page's hooks: drawn
         * on the live toast only — the recorded row has no action.
         */
        liveAction: LiveToastAction;
      }
  );

interface ToastFields {
  /**
   * Why it is shown. `reply` (the default) answers what the user just did and
   * is shown whatever the page's state (an error stays until handled);
   * `announcement` is something that happened on its own (the server
   * reconnecting) — shown only on a page on screen, gone after 4 s. Recorded
   * either way.
   */
  kind?: NotificationToastKind;
  type: string;
  /** Headline: the event, sentence case ("Conversation dropped"). */
  title: string;
  /**
   * Line 2 when there is no subject — user-safe words only (internals go to
   * `detail`). `""` when the subject says it all.
   */
  description: string;
  variant?: NotificationVariant;
  /** What it is about, in the user's words — the bell's chips. Required. */
  category: NotificationCategory;
  /** What it is about (a `conv-…` / `task-…` id) and its name as shown now. */
  subjectId?: string;
  subjectName?: string;
  /** Developer-only internals (HTTP status, raw error). */
  detail?: string;
  /** The event's own glyph; without one, the variant's or the category's. */
  icon?: SymbolRef;
  linkTo?: string;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
  /**
   * Who it is for: a `developer` toast is shown, and kept in the bell, only in
   * Developer mode. Default `user` — everyone.
   */
  audience?: Audience;
}

export const recentClientIds = new Set<string>();

/** Show a toast and record it in the bell — see `useToast`. */
export type Toast = (args: ToastArgs) => void;

/**
 * The toaster of this subtree: shows the toast at once — rendered in the
 * subtree's render origin, so its action and subject act there — then
 * persists it as a notification through the subtree's transport — so a toast
 * raised inside a scope with its own server (the demo) is shown, acted on and
 * written there, never on the computer's. Stable per transport and origin.
 *
 * Persisting is a fire-and-forget side-write of a toast already on screen.
 * It is declared `needsMachine` (D4): under a transport without the computer
 * (the demo) the toast stays ephemeral — shown, never written anywhere.
 */
export function useToast(): Toast {
  const fetchEndpoint = useFetchEndpoint();
  const persist = useMachineAvailability(createNotification).available;
  const toastNotification = useToastNotification();
  return useCallback(
    (args: ToastArgs) => {
      const variant = args.variant ?? "info";
      // Which tab raised it, and on which page: the view's meta line reads
      // "this tab" / "another Places tab" / "closed Places tab" off it.
      const metadata = {
        ...args.metadata,
        clientId: getTabId(),
        clientUrl: window.location.href,
      };

      // Minted first, so the toast's action can dismiss the row it becomes.
      const id = persist ? notificationIdKind.mint() : null;
      // The same view the bell's row draws, from the same fields.
      toastNotification(
        {
          id,
          type: args.type,
          title: args.title,
          description: args.description,
          variant,
          category: args.category,
          audience: args.audience ?? "user",
          subjectId: args.subjectId ?? null,
          subjectName: args.subjectName ?? null,
          detail: args.detail ?? null,
          action: args.action ?? null,
          icon: args.icon ?? null,
          // A toast raised in the page reports an event, not a standing problem.
          state: null,
          linkTo: args.linkTo ?? null,
          metadata,
          count: 1,
          ...(args.liveAction === undefined
            ? {}
            : { liveAction: args.liveAction }),
        },
        args.kind ?? "reply",
      );
      if (id === null) return;

      recentClientIds.add(id);
      setTimeout(() => recentClientIds.delete(id), 30_000);

      void fetchEndpoint(
        createNotification,
        {},
        {
          body: {
            id,
            type: args.type,
            title: args.title,
            description: args.description,
            variant,
            linkTo: args.linkTo ?? null,
            category: args.category,
            subjectId: args.subjectId ?? null,
            subjectName: args.subjectName ?? null,
            detail: args.detail ?? null,
            action: args.action ?? null,
            icon: args.icon ?? null,
            metadata,
            dedupeKey: args.dedupeKey ?? null,
            audience: args.audience,
          },
        },
      );
    },
    [fetchEndpoint, persist, toastNotification],
  );
}
