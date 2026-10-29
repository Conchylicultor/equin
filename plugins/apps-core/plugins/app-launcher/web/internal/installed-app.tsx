import type { ActiveApp } from "@plugins/apps-core/web";
import { AppIconAvatar } from "@plugins/apps-core/plugins/app-icon/web";
import type { Audience } from "@plugins/audience/core";
import {
  DeveloperCorner,
  DeveloperMark,
} from "@plugins/audience/plugins/developer-mark/web";
import { useAvatarPresentation } from "@plugins/primitives/plugins/avatar/web";
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
  audience: Audience;
  entry: ActiveApp;
}

/** The row of one installed app. */
export function appRow(entry: ActiveApp): AppRow {
  return {
    id: entry.id,
    name: entry.app.name,
    icon: entry.icon,
    audience: entry.app.audience ?? "user",
    entry,
  };
}

/**
 * An app's icon cell: `AppIconAvatar` (a tile filling the box in a tile view,
 * a badge in rows and table cells), and — on a tile — the developer mark on a
 * developer app's corner. A badge-sized avatar has no room for it; its row
 * carries the Audience field instead.
 */
export function AppIconCell({
  row,
}: {
  row: Pick<AppRow, "id" | "icon" | "audience">;
}) {
  const tile = useAvatarPresentation() !== "badge";
  return (
    <DeveloperCorner developer={tile && row.audience === "developer"}>
      <AppIconAvatar icon={row.icon} appId={row.id} />
    </DeveloperCorner>
  );
}

/**
 * The icon (an `app-icon` field, a visual) is the row's lead: drawn through `AppIconCell` (the
 * app's colour in `APP_TILE_PALETTE`; a tile filling the box in a tile view, a
 * badge in rows and table cells). Every list of apps passes these overrides, so
 * an app looks the same wherever it is launched from.
 */
export const appRowOverrides = fieldOverrides(installedApp, {});

export const installedAppPresentation = FieldPresentation.Register({
  owner: installedApp,
  fields: {
    icon: {
      // A glyph column: obvious from its cells, so no header text in a table.
      header: false,
      cell: (_icon, row) => <AppIconCell row={row} />,
    },
    // The developer mark for a developer app; nothing for everyone's.
    audience: {
      cell: (audience) => (audience === "developer" ? <DeveloperMark /> : null),
    },
  },
});
