import { useCallback } from "react";
import { showToast } from "@plugins/shell/plugins/toast/web";
import {
  useFetchEndpoint,
  useMachineAvailability,
} from "@plugins/infra/plugins/endpoints/web";
import { createNotification } from "../../shared/endpoints";
import type { NotificationVariant } from "../../shared/schema";
import { notificationIdKind } from "../../core";

export interface ToastArgs {
  type: string;
  /** Headline: states *what happened* (e.g. "Task created"). Always required. */
  title: string;
  /** Detail: the specific instance (e.g. "Fix login bug · sonnet"). Always required. */
  description: string;
  variant?: NotificationVariant;
  linkTo?: string;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
}

export const recentClientIds = new Set<string>();

/** Show a toast and persist it to the bell — see `useToast`. */
export type Toast = (args: ToastArgs) => void;

/**
 * The toaster of this subtree: shows the toast at once (Shell.Toast), then
 * persists it as a notification through the subtree's transport — so a toast
 * raised inside a scope with its own server (the demo) is written there, never
 * to the computer's. Stable per transport.
 *
 * Persisting is a fire-and-forget side-write of a toast already on screen.
 * It is declared `needsMachine` (D4): under a transport without the computer
 * (the demo) the toast stays ephemeral — shown, never written anywhere.
 */
export function useToast(): Toast {
  const fetchEndpoint = useFetchEndpoint();
  const persist = useMachineAvailability(createNotification).available;
  return useCallback(
    (args: ToastArgs) => {
      const variant = args.variant ?? "info";

      showToast({
        title: args.title,
        description: args.description,
        variant,
      });
      if (!persist) return;

      const id = notificationIdKind.mint();
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
            metadata: args.metadata ?? null,
            dedupeKey: args.dedupeKey ?? null,
          },
        },
      );
    },
    [fetchEndpoint, persist],
  );
}
