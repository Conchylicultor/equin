import { z } from "zod";
import { defineFieldIdentity, defineFieldType } from "@plugins/fields/core";
import { jsonFieldType } from "@plugins/fields/plugins/json/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import {
  enumTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { rowKind } from "@plugins/network/plugins/live/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import type { AppIcon } from "@plugins/apps-core/plugins/app-icon/core";
import { AUDIENCES } from "@plugins/audience/core";

const AppIconSchema: z.ZodType<AppIcon> = z.custom<AppIcon>(
  (v) => typeof v === "object" && v !== null && "kind" in v,
);

/**
 * The app's icon descriptor as a field type: a json blob (its table / filter
 * contributions are json's) of the `visual` kind, so every list of apps places
 * it as the row's lead — the tile's face — without naming it.
 */
export const appIconFieldType = defineFieldType<AppIcon>("app-icon");

export const appIconIdentity = defineFieldIdentity<AppIcon>({
  type: appIconFieldType,
  extends: jsonFieldType,
  kind: "visual",
  label: "App icon",
});

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
    icon: Object.freeze({
      ...jsonField({
        label: "Icon",
        schema: AppIconSchema,
        default: { kind: "symbol", symbol: symbol("apps") },
      }),
      type: appIconFieldType,
    }),
    // Who the app is for (`defineApp({ audience })`): a developer app is
    // listed only in Developer mode, and wears the developer mark there.
    audience: enumTextField(AUDIENCES, {
      label: "Audience",
      options: {
        user: { label: "Everyone" },
        developer: { label: "Developer" },
      },
    }),
  },
  carry: { fields: { id: textField() } },
  id: "id",
});
