import { useState, type ReactNode } from "react";
import {
  defineItemActions,
  type ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import type { AppRow } from "@plugins/apps-core/plugins/app-launcher/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  foldResource,
} from "@plugins/primitives/plugins/live-state/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  menuBarCapabilities,
  menuBarPinned,
  menuBarPinRequests,
  pinApp,
  type InstallCapabilities,
} from "@plugins/menu-bar/core";

const keepIcon = symbol("keep");
const errorIcon = symbol("error");

/** The app grid's per-tile actions (drawn on the tile's corner by the icons view). */
export const AppGridActions = defineItemActions<AppRow>();

/**
 * A pin in flight or failed rests on the tile (its spinner, its error), so it
 * does not vanish when the pointer leaves; the pin button itself is
 * hover-only. Unknown requests (loading, failed read) rest nothing — the
 * action itself says why it cannot be offered.
 */
export function usePinActive(row: AppRow): boolean {
  const requests = useLive(menuBarPinRequests);
  return foldResource(requests, {
    loading: () => false,
    error: () => false,
    unavailable: () => false,
    ready: (d) => d.requests.some((r) => r.appId === row.id),
  });
}

/** Where this host keeps pinned apps, in the user's words. */
function pinPlace(platform: InstallCapabilities["platform"]): string {
  return platform === "linux" ? "the dash" : "the Dock";
}

/**
 * The tile's pin: keeps the app in the Dock / GNOME dash through the
 * menu-bar pin endpoint. Every app is already an OS app of its own (main
 * keeps a shim for each), so a tile opens its window either way; this only
 * adds it to the Dock. Offered only once the host's capabilities, the pinned
 * set and the pin requests are all known — where the host can pin
 * (`capabilities.pin`) and the app is not pinned yet (dragging it out of the
 * Dock offers it again). A failed read is an error mark naming it (click:
 * re-read). Pending (the request, then the helper's build) is the button's
 * spinner; a failed pin keeps an error mark whose tooltip says why, and a
 * click on it tries again. The panel shows no toasts, so a pin the endpoint
 * refused outright (no computer behind the page) is that same error mark.
 */
export function PinAppAction({ row }: ItemActionProps<AppRow>): ReactNode {
  const fetchEndpoint = useFetchEndpoint();
  const [refused, setRefused] = useState<string | null>(null);
  const state = combineResources({
    capabilities: useLive(menuBarCapabilities),
    pinned: useLive(menuBarPinned),
    requests: useLive(menuBarPinRequests),
  });
  switch (state.status) {
    // Not known yet: there is no + to offer — and nothing claims there is none.
    case "loading":
      return null;
    // A transport without the computer (the demo): pinning is not a thing here.
    case "unavailable":
      return null;
    case "error":
      return (
        <ControlSizeProvider size="xs">
          <IconButton
            icon={errorIcon}
            label={`Can't tell whether ${row.name} is in the Dock: ${state.error.message} — click to retry`}
            variant="floating"
            shape="pill"
            className="text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              return state.refetch();
            }}
          />
        </ControlSizeProvider>
      );
    case "ready":
      break;
  }
  const { capabilities, pinned, requests } = state.data;
  if (!capabilities.pin) return null;
  if (pinned.appIds.includes(row.id)) return null;
  const request = requests.requests.find((r) => r.appId === row.id);
  const place = pinPlace(capabilities.platform);

  const pin = async () => {
    setRefused(null);
    const res = await fetchEndpoint(pinApp, { appId: row.id });
    if (res.kind === "unavailable") setRefused(res.message);
  };
  const failedMessage = request?.state === "failed" ? request.message : refused;
  return (
    <ControlSizeProvider size="xs">
      <IconButton
        // Its own round button on the icon's corner (the grid draws no chip):
        // the panel's surface, lit in the accent under the pointer.
        variant="floating"
        shape="pill"
        icon={failedMessage !== null ? errorIcon : keepIcon}
        label={
          failedMessage !== null
            ? `Keeping ${row.name} in ${place} failed: ${failedMessage} — click to retry`
            : `Keep ${row.name} in ${place}`
        }
        className={
          failedMessage !== null
            ? "text-destructive"
            : "hover:bg-primary hover:text-primary-foreground"
        }
        loading={request?.state === "waiting-for-helper"}
        onClick={(e) => {
          e.stopPropagation();
          return pin();
        }}
      />
    </ControlSizeProvider>
  );
}
