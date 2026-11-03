import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { armKeyCodec } from "@plugins/network/plugins/live/plugins/query-resource/core";

/**
 * The SQL a union arm projects its row key with: `'<kind>:' || <id>::text` —
 * byte-equal to `armKeyCodec(kind).encode(String(id))` for the id's text form
 * (what the change feed sends as `ids`, and what a reverse probe answers), so
 * a key the compiler projects and a key a route encodes can never disagree
 * (`arm-key-sql.test.ts` runs both against Postgres).
 *
 * Server-side, unlike the codec (core, browser-safe): it renders drizzle SQL.
 * The kind is inlined as a literal — `armKeyCodec` has checked it against
 * `KIND_RE` (no quote can reach the SQL), and a constant keeps every arm's
 * statement one plan whatever its params.
 */
export function armKeySql(kind: string, idCol: PgColumn | SQL): SQL<string> {
  const { kind: checked } = armKeyCodec(kind);
  // `text || text` is text, never NULL for a NOT NULL primary key.
  return sql`(${sql.raw(`'${checked}:'`)} || ${idCol}::text)`.mapWith(String);
}
