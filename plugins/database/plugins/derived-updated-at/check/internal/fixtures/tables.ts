// Fixture schema file for `declared.test.ts` — never in the drizzle schema
// globs (it lives under check/, not server/), so nothing migrates these tables.
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import {
  deriveUpdatedAt,
  derivedUpdatedAt,
} from "@plugins/database/plugins/derived-updated-at/server";

// An updated_at nobody declared: the check must name it.
export const undeclared = pgTable("dua_fixture_undeclared", {
  id: text("id").primaryKey(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// Declared through deriveUpdatedAt: the check must accept it.
export const declared = deriveUpdatedAt(
  pgTable("dua_fixture_declared", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    updatedAt: derivedUpdatedAt(),
  }),
  { touchedBy: { id: false, name: true } },
);

// No updated_at at all: out of scope.
export const plain = pgTable("dua_fixture_plain", {
  id: text("id").primaryKey(),
  touchedAt: timestamp("touched_at"),
});
