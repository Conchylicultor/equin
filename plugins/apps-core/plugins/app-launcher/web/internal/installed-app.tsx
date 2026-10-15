import type { ActiveApp } from "@plugins/apps-core/web";
import { AppIconAvatar } from "@plugins/apps-core/plugins/app-icon/web";
import { fieldOverrides } from "@plugins/primitives/plugins/data-view/web";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { installedApp } from "../../core";

/**
 * An installed app as a DataView row (the `installedApp` kind): its fields as
 * plain properties, plus the registry contribution it was projected from — what
 * activating the row (and any action on it) needs.
 */
export interface AppRow {
  id: string;
  name: string;
  icon: ActiveApp["icon"];
  entry: ActiveApp;
}

/** The row of one installed app. */
export function appRow(entry: ActiveApp): AppRow {
  return { id: entry.id, name: entry.app.name, icon: entry.icon, entry };
}

/**
 * The icon is the row's leading field: drawn through `AppIconAvatar` (the
 * app's colour in `APP_TILE_PALETTE`; a tile filling the box in a tile view, a
 * badge in rows and table cells). Every list of apps passes these overrides, so
 * an app looks the same wherever it is launched from.
 */
export const appRowOverrides = fieldOverrides(installedApp, {
  icon: { leading: true },
});

export const installedAppPresentation = FieldPresentation.Register({
  owner: installedApp,
  fields: {
    icon: {
      // A glyph column: obvious from its cells, so no header text in a table.
      header: false,
      cell: (icon, row) => <AppIconAvatar icon={icon} appId={row.id} />,
    },
  },
});
