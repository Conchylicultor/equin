/**
 * The `bytea` column type's wire form, declared once: every column built from it
 * carries the base64 codec, and that codec IS `bytesToBase64` — unfolded, where
 * Postgres' `encode(…, 'base64')` would break the line every 76 characters.
 */
import { describe, expect, test } from "bun:test";
import { pgTable, text } from "drizzle-orm/pg-core";
import {
  columnWireCodec,
  type ColumnWire,
} from "@plugins/database/plugins/sql-column/server";
import { bytea, bytesToBase64 } from "./bytea";

const docs = pgTable("bytea_t", {
  id: text("id").primaryKey(),
  state: bytea("state").notNull(),
});

describe("bytea", () => {
  test("its wire codec is bytesToBase64 — one line past 76 bytes", () => {
    const state = Uint8Array.from({ length: 500 }, (_, i) => (i * 131) % 256);
    const wire = columnWireCodec(docs.state)!.encode(state) as string;
    expect(wire).toBe(bytesToBase64(state));
    expect(wire).not.toContain("\n");
    expect(wire.length).toBeGreaterThan(76);
    expect(new Uint8Array(Buffer.from(wire, "base64"))).toEqual(state);
  });

  test("a row field for it is typed string (the wire type), not bytes", () => {
    const wire: ColumnWire<typeof docs.state> = { wire: "AAE=" };
    // @ts-expect-error — the wire type is base64, never the stored bytes
    const bytes: ColumnWire<typeof docs.state> = { wire: new Uint8Array() };
    expect([wire, bytes]).toHaveLength(2);
  });
});
