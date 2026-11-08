import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import {
  parsedJson,
  parsedText,
} from "@plugins/database/plugins/sql-column/server";
import {
  deriveUpdatedAt,
  derivedUpdatedAt,
} from "@plugins/database/plugins/derived-updated-at/server";
import {
  ColorAdjustmentSchema,
  TokenGroupFragmentsSchema,
} from "@plugins/ui/plugins/theme-engine/core";
import { SavedThemeSourceSchema } from "../../core";

// Every theme that is data rather than code: tweakcn imports and user custom
// themes. Code themes (`defineTheme`) are never rows.
//
// `updatedAt` is DERIVED (derived-updated-at): it moves when the theme's
// content really changes; no write site stamps it.
export const _savedThemes = deriveUpdatedAt(
  pgTable(
    "saved_themes",
    {
      // `tweakcn:<tweakcn id>` or `custom:<uuid>` — the colon marks a stored
      // theme, so an id can never collide with a code theme's bare one.
      id: text("id").primaryKey(),
      source: parsedText("source", SavedThemeSourceSchema).notNull(),
      // The id in the source's own catalog (tweakcn's theme id); null for custom.
      externalId: text("external_id"),
      label: text("label").notNull(),
      // Deliberately no FK: the parent may be a code theme, which has no row.
      // The create endpoint validates it instead, and `extends` is never
      // rewritten afterwards except by a delete folding a parent away.
      extends: text("extends"),
      // Decoded by the same schemas the wire declares.
      fragments: parsedJson("fragments", TokenGroupFragmentsSchema).notNull(),
      colorAdjust: parsedJson("color_adjust", ColorAdjustmentSchema),
      createdAt: timestamp("created_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
      updatedAt: derivedUpdatedAt(),
    },
    (t) => [
      // One row per external theme: re-importing a tweakcn theme updates it.
      uniqueIndex("saved_themes_external_id_uniq")
        .on(t.externalId)
        .where(sql`${t.externalId} IS NOT NULL`),
    ],
  ),
  {
    touchedBy: {
      source: true,
      externalId: true,
      label: true,
      extends: true,
      fragments: true,
      colorAdjust: true,
      id: false,
      createdAt: false,
    },
  },
);
