/**
 * `armKeySql` against a real Postgres: the key a union arm projects is
 * byte-equal to `armKeyCodec(kind).encode` of the id's text form — the form
 * the change feed sends as `ids` and a reverse probe answers — for text ids
 * (`:` and non-ASCII included), bigints and uuids.
 *
 * Run: `./equin test plugins/infra/plugins/query-resource`
 * (requires the running embedded cluster).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { bigint, pgTable, text, uuid } from "drizzle-orm/pg-core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { armKeyCodec } from "../../core/internal/arm-key";
import { armKeySql } from "./arm-key-sql";

const ids = pgTable("arm_key_ids", {
  id: text("id").primaryKey(),
  n: bigint("n", { mode: "bigint" }).notNull(),
  u: uuid("u").notNull(),
});

const ROWS = [
  ["plain", "1", "00000000-0000-0000-0000-000000000001"],
  ["a:b:c", "9223372036854775807", "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"],
  ["ünï ☃ 🙂", "-12", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
  [":", "0", "12345678-90ab-cdef-1234-567890abcdef"],
] as const;

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "qr_arm_key" });
  await t.db.execute(
    sql.raw(
      "CREATE TABLE arm_key_ids (id text PRIMARY KEY, n bigint NOT NULL, u uuid NOT NULL)",
    ),
  );
  for (const [id, n, u] of ROWS) {
    await t.db.execute(
      sql`INSERT INTO arm_key_ids (id, n, u) VALUES (${id}, ${n}::bigint, ${u}::uuid)`,
    );
  }
});

afterAll(async () => {
  await t.drop();
});

describe("armKeySql", () => {
  test("projects exactly what the codec encodes from the id's text form", async () => {
    const codec = armKeyCodec("remote-deploy");
    const rows = await t.db
      .select({
        id: ids.id,
        nText: sql<string>`${ids.n}::text`,
        uText: sql<string>`${ids.u}::text`,
        idKey: armKeySql("remote-deploy", ids.id),
        nKey: armKeySql("remote-deploy", ids.n),
        uKey: armKeySql("remote-deploy", ids.u),
      })
      .from(ids);
    expect(rows).toHaveLength(ROWS.length);
    for (const r of rows) {
      expect(r.idKey).toBe(codec.encode(r.id));
      expect(r.nKey).toBe(codec.encode(r.nText));
      expect(r.uKey).toBe(codec.encode(r.uText));
      expect(codec.decode(r.idKey)).toBe(r.id);
    }
    // The text form of each is the change feed's: the stored text as is.
    expect(rows.map((r) => r.nText).sort()).toEqual(
      ROWS.map(([, n]) => n).sort(),
    );
  });

  test("a kind KIND_RE refuses never reaches the SQL", () => {
    expect(() => armKeySql("x'; drop table y; --", ids.id)).toThrow(
      /plain identifier/,
    );
  });
});
