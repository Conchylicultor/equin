import type { ComponentType } from "react";
import { z } from "zod";
import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import { useAppLink } from "@plugins/apps-core/plugins/tabs/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import type { NotificationAction } from "../../core";

type Payload = NotificationAction["payload"];

/**
 * One kind of action a notification can offer (`action.kind`). Contributed by
 * the plugin that owns the kind; the notification view resolves a row's kind
 * through the registry and never names one.
 *
 * A kind is exactly one of two shapes, each a hook (an action needs the app's
 * navigation, an endpoint client, …) the view calls once per rendered
 * notification, then applies to the row's payload. It parses its own payload —
 * a payload its kind cannot read is an error, loudly.
 *
 * - `useLink` — the action GOES somewhere: it builds a `LinkTarget`. The whole
 *   notification (the bell's row, the toast's body) then opens it too, with
 *   the browser's link gestures (⌘/middle-click → a new browser tab), and the
 *   button is that same link.
 * - `useRun` — the action DOES something (reload, retry): only its button runs
 *   it; clicking the notification itself does nothing.
 * - `Control` — the action needs its own UI before it does anything (a
 *   launch popover asking for extra context): the kind draws its own control
 *   from the payload, at the compact control size the view provides, labelled
 *   with `label`. Clicking the notification itself does nothing.
 */
export type NotificationActionKind = {
  kind: string;
  /** The button's label ("Open", "Reload", "Retry"). */
  label: string;
} & (
  | {
      useLink: Hook<() => (payload: Payload) => LinkTarget>;
      useRun?: never;
      Control?: never;
    }
  | {
      useRun: Hook<() => (payload: Payload) => void>;
      useLink?: never;
      Control?: never;
    }
  | {
      Control: ComponentType<NotificationActionControlProps>;
      useLink?: never;
      useRun?: never;
    }
);

/** What a `Control` action kind is handed to draw its own control. */
export interface NotificationActionControlProps {
  payload: Payload;
  /** The kind's own `label`, for the control's face. */
  label: string;
}

export const Notifications = {
  /** The action registry: one contribution per `action.kind`. */
  Action: defineSlot<NotificationActionKind>({ docLabel: (a) => a.kind }),
};

/** The registered kind for `kind` — an unknown kind throws (fail loudly). */
export function resolveActionKind(
  kinds: readonly NotificationActionKind[],
  kind: string,
): NotificationActionKind {
  const found = kinds.find((k) => k.kind === kind);
  if (found === undefined) {
    throw new Error(
      `Notification action kind "${kind}" is not registered (Notifications.Action has: ${kinds.map((k) => k.kind).join(", ") || "none"}).`,
    );
  }
  return found;
}

const OpenPayloadSchema = z.object({ to: z.string().startsWith("/") });

/** `open`: navigate to an in-app route (`payload.to`). */
export const openAction: NotificationActionKind = {
  kind: "open",
  label: "Open",
  useLink: function useOpen() {
    const appLink = useAppLink();
    return (payload) => appLink(OpenPayloadSchema.parse(payload).to);
  },
};

/** `reload`: reload the page (a newer build is being served). */
export const reloadAction: NotificationActionKind = {
  kind: "reload",
  label: "Reload",
  useRun: function useReload() {
    return () => {
      window.location.reload();
    };
  },
};
