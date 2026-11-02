/**
 * Tests for the `no-unparsed-sql-rows` lint rule. Run with `bun test`.
 *
 * The invalid list is the three spellings from
 * research/2026-08-23-database-parsed-sql-rows.md — the explicit generic on
 * both `.query` and `.execute`, the destructured `rows`, and the two-statement
 * `const r = await …; r.rows` that is the common shape in this repo. The valid
 * list is the DDL/DML the rule must NOT touch, plus the `.rowCount`-only reads
 * that make the conjunction worth having.
 *
 * Who is exempt is not the rule's business: the owner's
 * own files are silenced by its `exempt/index.ts`, tested for every manifest
 * at once in lint/core's `exemptions-honored.test.ts`. Here the rule fires on
 * them, which is what proves it carries no owner allowlist of its own.
 */

import rule from "./no-unparsed-sql-rows";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

/** A file inside the owner directory — exempted by its manifest, not the rule. */
const OWNED = "plugins/database/plugins/sql-rows/core/internal/parse-rows.ts";
/** An ordinary consumer file, where it must fire. */
const CONSUMER = "plugins/database/plugins/admin/server/internal/databases.ts";

ruleTester.run("no-unparsed-sql-rows", rule, {
  valid: [
    // --- DDL/DML: the result is never read, so there is nothing to assert. ---
    { code: `await pool.query(ddl);` },
    { code: "await db.execute(sql`DELETE FROM jobs`);" },
    { code: `await client.query("BEGIN");` },
    { code: `await pool.query(sql, [a, b]);` },

    // --- The result is read, but not for rows. ---
    { code: `const r = await pool.query(s); if (r.rowCount) { done(); }` },
    { code: `const r = await pool.query(s); return r.rowCount ?? 0;` },
    { code: `const { rowCount } = await pool.query(s);` },
    { code: `return (await pool.query(s)).rowCount;` },

    // --- A same-named `.query()` on something else entirely. ---
    { code: `const el = container.query(".row"); el.focus();` },
    { code: `await queryClient.execute(job);` },

    // --- The sanctioned door. ---
    { code: `const rows = await queryRows(pool, { sql, row });` },
    { code: `const r = await executeRows(db, { query, row }); use(r);` },
    { code: `const one = await queryOne(pool, { sql, row });` },
  ],
  invalid: [
    // --- (a) An explicit type argument is a pure assertion. ---
    {
      code: `await pool.query<{ a: string }>(sql);`,
      errors: [{ messageId: "unparsedSqlRows" }],
    },
    {
      code: "await db.execute<Row>(q);",
      errors: [{ messageId: "unparsedSqlRows" }],
    },
    {
      filename: CONSUMER,
      code: `await pool.query<Row>(sql);`,
      errors: [{ messageId: "unparsedSqlRows" }],
    },
    {
      // The owner's own file: sql-rows/exempt/index.ts silences it.
      filename: OWNED,
      code: `const r = await client.query(sql, params); return r.rows;`,
      errors: [{ messageId: "unparsedSqlRows" }],
    },

    // --- (b) Rows are read: the bare form, which asserts nothing at all. ---
    {
      code: `const { rows } = await pool.query(s);`,
      errors: [{ messageId: "unparsedSqlRows" }],
    },
    {
      // The common two-statement shape — resolved through scope analysis.
      code: `const r = await pool.query(s); return r.rows;`,
      errors: [{ messageId: "unparsedSqlRows" }],
    },
    {
      code: `return (await db.execute(q)).rows;`,
      errors: [{ messageId: "unparsedSqlRows" }],
    },
    {
      filename: CONSUMER,
      code: `const r = await pool.query(s); return r.rows;`,
      errors: [{ messageId: "unparsedSqlRows" }],
    },

    // --- Further row-reading shapes. ---
    {
      // The result is bound, then destructured a statement later.
      code: `const r = await pool.query(s); const { rows } = r; use(rows);`,
      errors: [{ messageId: "unparsedSqlRows" }],
    },
    {
      // `for…of` over the rows — the exact loop the incident mis-walked.
      code: `for (const t of (await pool.query(s)).rows) { use(t); }`,
      errors: [{ messageId: "unparsedSqlRows" }],
    },
    {
      // Optional call on a maybe-client.
      code: `const r = await client?.query(s); if (r) { use(r.rows); }`,
      errors: [{ messageId: "unparsedSqlRows" }],
    },
    {
      // Promise form, no await.
      code: `pool.query(s).then((r) => r.rows);`,
      errors: [{ messageId: "unparsedSqlRows" }],
    },
    {
      // Both halves at once — the generic AND the rows read.
      code: `const r = await db.execute<Row>(q); return r.rows;`,
      errors: [{ messageId: "unparsedSqlRows" }],
    },
    {
      // Two offenders, and the DDL between them is not one.
      code:
        `const a = await pool.query(s1); use(a.rows);` +
        `await pool.query(ddl);` +
        `const { rows } = await pool.query(s2);`,
      errors: [
        { messageId: "unparsedSqlRows" },
        { messageId: "unparsedSqlRows" },
      ],
    },
  ],
});
