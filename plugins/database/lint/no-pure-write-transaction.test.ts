/**
 * Tests for the `no-pure-write-transaction` lint rule. The invalid shapes are
 * the real call sites it found when it landed (each since rewritten onto
 * `writeAtomically` or a single statement); the valid ones are the reasons a
 * transaction exists — a read feeding a write, a lock, a helper the rule
 * cannot see into.
 */

import rule from "./no-pure-write-transaction";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const tx = (body: string) => `await db.transaction(async (tx) => { ${body} });`;

ruleTester.run("no-pure-write-transaction", rule, {
  valid: [
    // One write: one round trip, no idle window.
    { code: tx(`await tx.insert(t).values(v);`) },
    // A read whose result feeds the write.
    {
      code: tx(
        `const [row] = await tx.select().from(t).where(w).for("update");` +
          `if (row) await tx.insert(u).values(v);`,
      ),
    },
    // A used result (RETURNING) is a read.
    {
      code: tx(
        `const [r] = await tx.insert(t).values(v).returning();` +
          `await tx.insert(u).values({ id: r.id });`,
      ),
    },
    // An explicit lock.
    {
      code: tx(
        "await tx.execute(sql`SELECT pg_advisory_xact_lock(42)`);" +
          "await tx.insert(t).values(v);",
      ),
    },
    {
      code: tx(
        "await tx.execute(sql`LOCK TABLE jobs IN EXCLUSIVE MODE`);" +
          "await tx.delete(t);",
      ),
    },
    // A helper handed the executor: the rule cannot see what it does.
    { code: tx(`await lockDeck(tx); await tx.update(t).set(v);`) },
    // A nested async callback: its round trips are not countable here.
    {
      code: tx(
        `await tx.insert(t).values(v);` +
          `await Promise.all(rows.map(async (r) => { await tx.insert(u).values(r); }));`,
      ),
    },
    // Exclusive branches: one round trip whichever runs.
    {
      code: tx(
        `if (a) await tx.insert(t).values(v); else await tx.update(t).set(s);`,
      ),
    },
    {
      code: tx(
        `switch (k) { case 1: await tx.insert(t).values(v); break; default: await tx.delete(t); }`,
      ),
    },
    // Not a transaction callback.
    { code: `await db.insert(t).values(v); await db.insert(u).values(w);` },
  ],
  invalid: [
    // run-ledger: run, run-events (conditional), source row.
    {
      code: tx(
        `await tx.insert(runs).values(run);` +
          `if (touched.length > 0) await tx.insert(runEvents).values(touched.map((t) => ({ id: t.id })));` +
          `await tx.update(sources).set(s).where(w);`,
      ),
      errors: [{ messageId: "pureWrites" }],
    },
    // trigger-contributions: a delete per table, an insert per table.
    {
      code: tx(
        `for (const table of tables) await tx.delete(table).where(w);` +
          `for (const [table, rows] of byTable) { await tx.insert(table).values(rows); }`,
      ),
      errors: [{ messageId: "pureWrites" }],
    },
    // track-mixer / events reanchor: one write per item, in a loop.
    {
      code: tx(
        `for (const id of ids) { await tx.insert(t).values({ id }).onConflictDoUpdate({ target: t.id, set }); }`,
      ),
      errors: [{ messageId: "pureWrites" }],
    },
    // A branch that writes, then a write after it.
    {
      code: tx(
        `if (a) await tx.insert(t).values(v); await tx.update(u).set(s);`,
      ),
      errors: [{ messageId: "pureWrites" }],
    },
    // Raw-SQL writes count too.
    {
      code: tx(
        "await tx.execute(sql`INSERT INTO a SELECT * FROM b`);" +
          "await tx.execute(sql`\n  DELETE FROM b`);",
      ),
      errors: [{ messageId: "pureWrites" }],
    },
  ],
});
