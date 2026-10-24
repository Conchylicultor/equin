import type { ReactNode } from "react";
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
import { showToast } from "@plugins/shell/plugins/toast/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  installApp,
  menuBarCapabilities,
  menuBarInstalled,
  menuBarInstallRequests,
} from "@plugins/menu-bar/core";

const addIcon = symbol("add");
const errorIcon = symbol("error");

/** The app grid's per-tile actions (drawn on the tile's corner by the icons view). */
export const AppGridActions = defineItemActions<AppRow>();

/**
 * An install in flight or failed rests on the tile (its spinner, its error),
 * so it does not vanish when the pointer leaves; the + itself is hover-only.
 * Unknown requests (loading, failed read) rest nothing — the action itself
 * says why it cannot be offered.
 */
export function useInstallActive(row: AppRow): boolean {
  const requests = useLive(menuBarInstallRequests);
  return foldResource(requests, {
    loading: () => false,
    error: () => false,
    unavailable: () => false,
    ready: (d) => d.requests.some((r) => r.appId === row.id),
  });
}

/**
 * The tile's **+**: installs the app as an OS app of its own (its own window,
 * Dock / dash icon) through the menu-bar install endpoint. Offered only once
 * the host's capabilities, the installed set and the install requests are all
 * known — where the host can install (`capabilities.install`) and the app is
 * not installed yet. A failed read is an error mark naming it (click:
 * re-read). Pending (the request, then the helper's build) is the button's
 * spinner; a failed install keeps an error mark whose tooltip says why, and a
 * click on it tries again.
 */
export function InstallAppAction({ row }: ItemActionProps<AppRow>): ReactNode {
  const fetchEndpoint = useFetchEndpoint();
  const state = combineResources({
    capabilities: useLive(menuBarCapabilities),
    installed: useLive(menuBarInstalled),
    requests: useLive(menuBarInstallRequests),
  });
  switch (state.status) {
    // Not known yet: there is no + to offer — and nothing claims there is none.
    case "loading":
      return null;
    // A transport without the computer (the demo): installing is not a thing here.
    case "unavailable":
      return null;
    case "error":
      return (
        <ControlSizeProvider size="xs">
          <IconButton
            icon={errorIcon}
            label={`Can't tell whether ${row.name} can be installed: ${state.error.message} — click to retry`}
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
  const { capabilities, installed, requests } = state.data;
  if (!capabilities.install) return null;
  if (installed.appIds.includes(row.id)) return null;
  const request = requests.requests.find((r) => r.appId === row.id);

  const install = async () => {
    const res = await fetchEndpoint(installApp, { appId: row.id });
    if (res.kind === "unavailable") {
      showToast({
        title: `Couldn't install ${row.name}`,
        description: res.message,
        variant: "error",
      });
    }
  };
  const failed = request?.state === "failed" ? request : null;
  return (
    <ControlSizeProvider size="xs">
      <IconButton
        // Its own round button on the icon's corner (the grid draws no chip):
        // the panel's surface, lit in the accent under the pointer.
        variant="floating"
        shape="pill"
        icon={failed ? errorIcon : addIcon}
        label={
          failed
            ? `Installing ${row.name} failed: ${failed.message} — click to retry`
            : `Install ${row.name} as an app`
        }
        className={
          failed
            ? "text-destructive"
            : "hover:bg-primary hover:text-primary-foreground"
        }
        loading={request?.state === "waiting-for-helper"}
        onClick={(e) => {
          e.stopPropagation();
          return install();
        }}
      />
    </ControlSizeProvider>
  );
}
