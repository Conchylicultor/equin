import type { ReactNode } from "react";
import {
  defineItemActions,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import type { AppRow } from "@plugins/apps-core/plugins/app-launcher/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useNativeApps, useNativeHost } from "@plugins/menu-bar/web";

const keepIcon = symbol("keep");
const errorIcon = symbol("error");

/** The app grid's per-tile actions (drawn on the tile's corner by the icons view). */
export const AppGridActions = defineItemActions<AppRow>();

/**
 * A pin in flight or failed rests on the tile (its spinner, its error), so it
 * does not vanish when the pointer leaves; the pin button itself is
 * hover-only. Unknown (the helper has not answered) rests nothing.
 */
export function usePinActive(row: AppRow): boolean {
  const apps = useNativeApps();
  return apps.kind === "ready" && apps.requests.has(row.id);
}

/** Where this desktop keeps pinned apps, in the user's words. */
function pinPlace(platform: "macos" | "linux"): string {
  return platform === "linux" ? "the dash" : "the Dock";
}

/**
 * The tile's pin: keeps the app in the Dock / GNOME dash — a device power, so
 * the native helper's (`pinApp`, through the bridge), never the server's.
 * Every app is already an OS app of its own (the helper keeps a shim for
 * each), so a tile opens its window either way; this only adds it to the
 * Dock. Offered only once the helper answered — where it keeps the apps and
 * can pin, and the app is not pinned yet (dragging it out of the Dock offers
 * it again on the panel's next open). A failed read is an error mark naming it
 * (click: re-read). In flight is the button's spinner; a failed pin keeps an
 * error mark whose tooltip says why, and a click on it tries again.
 */
export function PinAppAction({ row }: ItemActionProps<AppRow>): ReactNode {
  const host = useNativeHost();
  const apps = useNativeApps();
  switch (apps.kind) {
    // Not known yet: there is no pin to offer — and nothing claims there is none.
    case "pending":
      return null;
    // No helper keeping the apps (a plain browser, a dev tray): pinning is not a thing here.
    case "unavailable":
      return null;
    case "error":
      return (
        <ControlSizeProvider size="xs">
          <IconButton
            icon={errorIcon}
            label={`Can't tell whether ${row.name} is in the Dock: ${apps.error.message} — click to retry`}
            variant="floating"
            shape="pill"
            className="text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              return apps.refresh();
            }}
          />
        </ControlSizeProvider>
      );
    case "ready":
      break;
  }
  const { pin } = apps;
  if (pin === null || host.kind !== "present") return null;
  if (apps.apps.pinned.includes(row.id)) return null;
  const request = apps.requests.get(row.id);
  const place = pinPlace(host.platform);
  const failed = request?.state === "failed" ? request.message : null;
  return (
    <ControlSizeProvider size="xs">
      <IconButton
        // Its own round button on the icon's corner (the grid draws no chip):
        // the panel's surface, lit in the accent under the pointer.
        variant="floating"
        shape="pill"
        icon={failed !== null ? errorIcon : keepIcon}
        label={
          failed !== null
            ? `Keeping ${row.name} in ${place} failed: ${failed} — click to retry`
            : `Keep ${row.name} in ${place}`
        }
        className={
          failed !== null
            ? "text-destructive"
            : "hover:bg-primary hover:text-primary-foreground"
        }
        loading={request?.state === "pinning"}
        onClick={(e) => {
          e.stopPropagation();
          return pin(row.id);
        }}
      />
    </ControlSizeProvider>
  );
}
