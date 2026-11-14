import { useMemo } from "react";
import { afterOpen } from "@plugins/primitives/plugins/link-gesture/core";
import { useActiveApp, useListedApps } from "@plugins/apps-core/web";
import { useActivateApp } from "@plugins/apps-core/plugins/tabs/web";
import type { PhoneActionSheetProps } from "@plugins/apps-core/plugins/phone-actions/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  DataView,
  defineDataView,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  HostedToolbar,
  HostedToolbarParts,
} from "@plugins/primitives/plugins/data-view/core";
import type { IconsViewOptions } from "@plugins/primitives/plugins/data-view/plugins/icons/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { installedApp } from "../../core";
import {
  appRow,
  appRowOverrides,
  type AppRow,
} from "../internal/installed-app";

const PHONE_APPS_VIEW = defineDataView("apps-core.phone-apps");

const NO_APPS: readonly AppRow[] = [];

/** No toolbar band: the sheet is the grid. */
function GridFrame({ body }: HostedToolbarParts) {
  return body;
}

const GRID_TOOLBAR: HostedToolbar = { kind: "hosted", frame: GridFrame };

/** Four tiles a row, sharing the sheet's width. */
const GRID_VIEW_OPTIONS: { icons: IconsViewOptions<AppRow> } = {
  icons: { menu: { columns: 4 } },
};

/**
 * The phone action button's Apps sheet (`PhoneActions.Action` "apps"): every
 * listed app, in the rail's order, as the icons DataView — the same rows,
 * fields and tiles as the launcher's grid and Home's gallery — the current
 * app marked. A tile switches app exactly as the rail does and closes the
 * sheet.
 */
export function AppsSheet({ close }: PhoneActionSheetProps) {
  const listed = useListedApps();
  const rows = useMemo(
    () =>
      foldResource(listed, {
        loading: () => NO_APPS,
        error: () => NO_APPS,
        ready: (apps) => apps.map(appRow),
      }),
    [listed],
  );
  const active = useActiveApp();
  const activate = useActivateApp();
  return (
    <Stack gap="md">
      <Text as="div" variant="caption" tone="muted">
        Apps
      </Text>
      <DataView<AppRow>
        rows={rows}
        readiness={listed}
        rowKey={(a) => a.id}
        collection={installedApp}
        overrides={appRowOverrides}
        views={["icons"]}
        defaultView="icons"
        viewOptions={GRID_VIEW_OPTIONS}
        toolbar={GRID_TOOLBAR}
        storageKey={PHONE_APPS_VIEW}
        selectedRowId={active?.id}
        rowActivation={(row) => afterOpen(activate(row.entry), close)}
        emptyState="No apps."
      />
    </Stack>
  );
}
