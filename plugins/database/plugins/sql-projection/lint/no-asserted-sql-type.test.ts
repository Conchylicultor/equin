/**
 * Tests for the `no-asserted-sql-type` lint rule. Run with `bun test`.
 *
 * The invalid list is the two spellings from
 * research/2026-08-25-database-mapped-sql-projections.md — the type argument on
 * the tag, and drizzle's deprecated `SQL.as<TData>()` one call later. The valid
 * list is everything the rule must NOT touch: the sanctioned `.mapWith(…)`
 * forms, the bare template (which is honestly `SQL<unknown>`), the plain
 * `.as("alias")`, and every `.as<T>()` that has nothing to do with drizzle.
 */

import rule from "./no-asserted-sql-type";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

/** A file inside the owner directory, where the rule must stay silent. */
const OWNED =
  "plugins/database/plugins/sql-projection/server/internal/decoders.ts";
/** An ordinary consumer file, where it must fire. */
const CONSUMER = "plugins/tasks/plugins/tasks-core/server/internal/views.ts";

ruleTester.run("no-asserted-sql-type", rule, {
  valid: [
    // --- The sanctioned door: the type comes from the decoder. ---
    { code: "const a = sql`(x IS NULL)`.mapWith(Boolean).as('active');" },
    { code: "const a = sql`count(*)::int`.mapWith(Number).as('n');" },
    {
      code: "const a = sql`min(t.created_at)`.mapWith(nullable(t.createdAt)).as('finished_at');",
    },
    {
      code: "const a = sql`CASE END`.mapWith(parsed(StatusSchema, 'tasks_v.status')).as('status');",
    },

      // --- No type argument at all: honestly `SQL<unknown>`. ---
      { code: "const a = sql`blocks.data -> 'icon'`;" },
      { code: "const a = sql`true`.as('has_attempt');" },
      { code: "await db.execute(sql`DELETE FROM jobs`);" },
      { code: "const w = sql`count(*) > 1`;" },

      // --- `.as<T>()` that has nothing to do with a drizzle SQL template. ---
      { code: "const a = builder.as<Foo>();" },
      { code: "const a = qb.select().from(t).as<Sub>('sub');" },
      { code: "const a = notSql`x`.as<Foo>('y');" },

      // --- The owner directory documents the banned form in order to name it. ---
      { code: "const a = sql<boolean>`x`;", filename: OWNED },
      { code: "const a = sql`x`.as<number>('n');", filename: OWNED },
    ],
    invalid: [
      // --- The type argument on the tag. ---
      {
        code: "const a = sql<boolean>`(x IS NULL)`.as('is_folder');",
        errors: [{ messageId: "assertedSqlType" }],
      },
      {
        code: "const a = sql<Date | null>`min(t.created_at)`.as('finished_at');",
        filename: CONSUMER,
        errors: [{ messageId: "assertedSqlType" }],
      },
      {
        code: "const a = sql<string[]>`array_agg(t.id)`.as('ids');",
        errors: [{ messageId: "assertedSqlType" }],
      },
      // A `string` type argument gets no free pass — `sql<string>`count(*)`` is
      // true only by luck, and `.mapWith(String)` says it while making it true.
      {
        code: "const a = sql<string>`count(*)`;",
        errors: [{ messageId: "assertedSqlType" }],
      },
      // `unknown` is what you get for free by dropping the argument, so writing
      // it is still writing a type instead of a decoder.
      {
        code: "const a = sql<unknown>`t.data -> 'icon'`;",
        errors: [{ messageId: "assertedSqlType" }],
      },
      // Adding `.mapWith` does not rescue it: the type argument is then dead
      // code that reads like the source of truth.
      {
        code: "const a = sql<boolean>`x`.mapWith(Boolean).as('active');",
        errors: [{ messageId: "assertedSqlType" }],
      },

      // --- Drizzle's deprecated `SQL.as<TData>()`, the same assertion later. ---
      {
        code: "const a = sql`min(t.created_at)`.as<Date>('finished_at');",
        errors: [{ messageId: "assertedSqlAlias" }],
      },
      {
        code: "const a = sql`x`.as<number>();",
        filename: CONSUMER,
        errors: [{ messageId: "assertedSqlAlias" }],
      },
      // Through a chain — the only way to reach `SQL.as` is off a `sql` template.
      {
        code: "const a = sql`x`.inlineParams().as<boolean>('b');",
        errors: [{ messageId: "assertedSqlAlias" }],
      },

      // --- Both spellings in one file are two separate reports. ---
      {
        code: "const a = sql<boolean>`x`.as('a');\nconst b = sql`y`.as<number>('b');",
        errors: [
          { messageId: "assertedSqlType" },
          { messageId: "assertedSqlAlias" },
        ],
      },
    ],
  },
);
