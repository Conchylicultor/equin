import { sql } from "drizzle-orm";
import { uniqueIndex } from "drizzle-orm/pg-core";
import {
  defineEntity,
  defaultNow,
} from "@plugins/infra/plugins/entities/server";
import { placeFields, placeTagFields } from "../../core";

// Physical tables for the Places app, derived from the field records in
// `core/internal/fields.ts`. A load-order leaf (no other plugin's tables, no
// top-level await): drizzle-kit's sync loader evaluates it. Re-exported with a
// leading `_` for drizzle-kit's schema glob.

const places = defineEntity("places", placeFields, {
  primaryKey: "id",
  // Which columns move `updatedAt` (a DB trigger derives it). Everything the
  // user sees; `fetchedAt` is bookkeeping.
  updatedAt: {
    touchedBy: {
      id: false,
      googlePlaceId: true,
      name: true,
      address: true,
      location: true,
      primaryType: true,
      types: true,
      mapsUrl: true,
      icon: true,
      note: true,
      tags: true,
      autoTags: true,
      fetchedAt: false,
      createdAt: false,
    },
  },
  columns: {
    types: { default: [] },
    note: { default: "" },
    tags: { default: [] },
    autoTags: { default: [] },
    fetchedAt: { default: defaultNow() },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
  indexes: (t) => [
    // A Google place is saved once; the save's ON CONFLICT targets this.
    uniqueIndex("places_google_place_id_idx").on(t.googlePlaceId),
  ],
});

const placeTags = defineEntity("place_tags", placeTagFields, {
  primaryKey: "id",
  updatedAt: {
    touchedBy: {
      id: false,
      name: true,
      parentId: true,
      color: true,
      icon: true,
      googleTypes: true,
      rank: true,
      role: true,
      createdAt: false,
    },
  },
  columns: {
    googleTypes: { default: [] },
    rank: { default: 0 },
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
  indexes: (t) => [
    // At most one tag per role: the status logic resolves todo / done by it.
    uniqueIndex("place_tags_role_idx")
      .on(t.role)
      .where(sql`${t.role} IS NOT NULL`),
  ],
});

// drizzle-kit schema-glob discovery.
export const _places = places.table;
export const _placeTags = placeTags.table;
