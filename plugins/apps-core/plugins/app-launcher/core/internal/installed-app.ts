import { z } from "zod";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { rowKind } from "@plugins/network/plugins/live/core";
import type { ZodParser } from "@plugins/packages/plugins/zod-parser/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { AppIcon } from "@plugins/apps-core/plugins/app-icon/core";

const AppIconSchema: ZodParser<AppIcon> = z.custom<AppIcon>(
  (v) => typeof v === "object" && v !== null && "kind" in v,
);

/**
 * An installed app as a row: what every list of apps (the launcher's grid, the
 * Home gallery) shows of it — its name and its icon. Apps are no database
 * data (they are the `Apps.App` registry's contributions), so this is a row
 * kind, a collection with no server, declared once: each list names it, and a
 * plugin adding fields to every list of apps (the Home gallery's usage stats)
 * declares them on it (`clientFields(installedApp, …)`).
 */
export const installedApp = rowKind("apps.installed-app", {
  fields: {
    name: textField({ label: "Name" }),
    icon: jsonField({
      label: "Icon",
      schema: AppIconSchema,
      default: { kind: "symbol", symbol: symbol("apps") },
    }),
  },
  carry: { fields: { id: textField() } },
  id: "id",
});
