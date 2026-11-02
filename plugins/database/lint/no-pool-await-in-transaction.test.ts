/**
 * Tests for the `no-pool-await-in-transaction` lint rule. Run with `bun test`.
 *
 * The valid/invalid lists are the audited real call sites from
 * research/2026-07-09-global-interactive-lane-origin-based-db-gating.md § Task 5:
 * every legitimate executor-threading shape must pass, and the three known
 * pool-inside-transaction shapes must fail.
 */

import rule from "./no-pool-await-in-transaction";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

/** Wrap a statement body in the transaction callback under test. */
const tx = (body: string) => `await db.transaction(async (tx) => { ${body} });`;

/**
 * The same, for the page editor's forest-write chokepoint — a transaction scope
 * whose callback binds a CONTEXT object (`ctx.tx` is the executor) and whose
 * callback is the SECOND argument. Stage 1 of
 * research/2026-08-01-page-structural-write-contract.md moved every page-editor
 * write inside one of these, which made the rule blind to them until
 * `TX_SCOPE_OPENERS` learned the shape.
 */
const forest = (body: string) =>
  `await withPageForest(pageId, async (ctx) => { ${body} });`;

ruleTester.run("no-pool-await-in-transaction", rule, {
  valid: [
    // --- Audited legitimate sites: the executor is threaded. ---
    { code: tx(`await insertForest(tx, { rootId, blocks });`) }, // page/editor
    { code: tx(`await computePageId(root.parentId, tx);`) }, // page/editor
    { code: tx(`await nextRankIn(_conversationGroups, tx);`) }, // conversations/grouped
    { code: tx(`await ensureChangelogTable(tx);`) }, // change-feed
    { code: tx(`await rebuildDerivedViews(tx);`) }, // migrations runner
    {
      code: tx(
        `await tx.insert(t).values(v).onConflictDoUpdate({ target: t.id });`,
      ),
    }, // slow-ops
    { code: tx(`await store.run(batch, () => fn(tx));`) }, // tasks-core status-batch
    {
      // tasks-core withTaskStatusBatch: the executor rides inside `batch`.
      code: tx(
        `const batch = { tx, before: new Map() };` +
          `const result = await store.run(batch, () => fn(tx));` +
          `await flushStatusBatch(batch);`,
      ),
    },
    { code: tx("await tx.execute(sql`delete from jobs`);") }, // dead-job-gc

      // --- Other shapes the executor reaches. ---
      // Long member chain rooted at the executor.
      { code: tx(`await tx.select().from(tasks).where(eq(tasks.id, id));`) },
      // Options-object property (`{ tx: batch.tx }` — tasks-core status events).
      { code: tx(`await taskStatusChanged.emit(payload, { tx: batch.tx });`) },
      // Shorthand property.
      { code: tx(`await emit(payload, { tx });`) },
      // Non-async callback returning a promise chain.
      { code: `db.transaction((tx) => insertForest(tx, { rootId }));` },
      // Awaiting a non-call expression is out of scope — the rule bans pool CALLS.
      { code: tx(`await pending;`) },
      // A nested transaction rebinds the executor; the inner callback is judged
      // on ITS OWN binding, so `inner.insert(…)` is fine even though `tx` is
      // lexically visible and unused.
      { code: tx(`await tx.transaction(async (inner) => { await inner.insert(t); });`) },
      // A callback with no plain-identifier param binds no executor — nothing to
      // verify, so we stay silent rather than report every await.
      { code: `await db.transaction(async () => { await db.select().from(t); });` },
      // A pool call OUTSIDE any transaction callback is this rule's non-business.
      { code: `await db.select().from(tasks);` },

      // --- withPageForest: the context-object binding threads the executor. ---
      // The audited real sites from the page editor's server tree.
      { code: forest(`const rows = await ctx.forest();`) }, // rooted at the binding
      { code: forest(`await ctx.tx.select().from(_blocks).where(w);`) },
      { code: forest(`await writeForestTarget(ctx, before, after);`) }, // ctx as arg
      { code: forest(`await updateBlockFields(ctx.tx, id, changes);`) }, // ctx.tx as arg
      { code: forest(`await recomputePageIdSubtree(ctx.tx, rootId);`) },
      { code: forest(`await loadPageBlocks(pageId, ctx.tx);`) }, // executor is 2nd arg
      { code: forest(`await nextRankUnder(_blocks, _blocks.parentId, null, ctx.tx);`) },
      // Deferred work is the sanctioned escape, and it is not an await at all.
      { code: forest(`ctx.afterCommit(() => runOnTrash(ids));`) },
      // A carrier struct built from the context still reaches the executor.
      {
        code: forest(
          `const batch = { tx: ctx.tx, seen: new Map() };` +
            `await flushBatch(batch);`,
        ),
      },
      // Callback with no plain-identifier param binds nothing to verify.
      { code: `await withPageForest(pageId, async () => { await db.select(); });` },
      // A `withPageForest` OUTSIDE any scope is this rule's non-business.
      { code: `await withPageForest(pageId, async (ctx) => ctx.forest());` },
      // Not the registered opener: a `with*` scope helper that holds no
      // connection must not turn its body's pool calls into errors.
      { code: `await withHeavyReadSlot(async () => { await db.select().from(t); });` },
    ],
    invalid: [
      // The real bug: queue/server/internal/repair-blocked-order.ts:42 — the
      // helper takes no executor, so it queues for a second pool connection
      // while the transaction pins the first.
      {
        code: tx(`await listBlockingDepIds(taskId);`),
        errors: [{ messageId: "poolAwait" }],
      },
      // Explicit pool read from inside the transaction.
      {
        code: tx(`await db.select().from(x);`),
        errors: [{ messageId: "poolAwait" }],
      },
      // Non-DB I/O inflates the connection lease just the same.
      {
        code: tx(`await fetch(url);`),
        errors: [{ messageId: "poolAwait" }],
      },
      // A nested transaction's own callback is checked against ITS binding: the
      // outer `tx` does not launder a pool read in the inner one.
      {
        code: tx(`await tx.transaction(async (inner) => { await db.select().from(t); });`),
        errors: [{ messageId: "poolAwait" }],
      },
      // A second connection is a second connection: awaiting a transaction on a
      // DIFFERENT executor from inside this one is the hold-and-wait shape.
      {
        code: tx(`await other.transaction(async (inner) => { await inner.insert(t); });`),
        errors: [{ messageId: "poolAwait" }],
      },
      // A query RESULT is data, not an executor — it must not launder the next
      // call the way a `{ tx }` carrier struct does.
      {
        code: tx(`const rows = await tx.select().from(t); await enrich(rows);`),
        errors: [{ messageId: "poolAwait" }],
      },
      // Both offenders are reported, and the legitimate one between them is not.
      {
        code: tx(`await fetch(url); await tx.insert(t); await readFile(p);`),
        errors: [{ messageId: "poolAwait" }, { messageId: "poolAwait" }],
      },

      // --- withPageForest: the probe that proved the rule had gone blind. ---
      // A pool-defaulted helper AND an explicit pool call, both inside one
      // forest-write callback. Before TX_SCOPE_OPENERS this produced ZERO
      // errors — Stage 1 closed the lock hole and opened this one in the same
      // move.
      {
        code: forest(
          `const rows = await loadPageBlocks(pageId);` +
            `await db.execute(sql\`select 1\`);`,
        ),
        errors: [{ messageId: "poolAwait" }, { messageId: "poolAwait" }],
      },
      // The single-call shapes, so a regression names which half broke.
      {
        code: forest(`await loadPageBlocks(pageId);`),
        errors: [{ messageId: "poolAwait" }],
      },
      {
        code: forest(`await db.select().from(_blocks);`),
        errors: [{ messageId: "poolAwait" }],
      },
      // Non-DB I/O inflates the lease — and the page lock — just the same.
      {
        code: forest(`await deleteSearchDocs("pages", pageIds);`),
        errors: [{ messageId: "poolAwait" }],
      },
      // A query RESULT is data, not the executor: it must not launder the next
      // call, exactly as in a bare transaction.
      {
        code: forest(`const rows = await ctx.forest(); await reindex(rows);`),
        errors: [{ messageId: "poolAwait" }],
      },
      // A SECOND chokepoint opened from inside one is hold-and-wait: it queues
      // for another connection while this one is pinned.
      {
        code: forest(`await withPageForest(otherId, async (inner) => inner.forest());`),
        errors: [{ messageId: "poolAwait" }],
      },
      // …and a bare transaction opened from inside a forest write is the same.
      {
        code: forest(`await db.transaction(async (inner) => { await inner.insert(t); });`),
        errors: [{ messageId: "poolAwait" }],
      },
      // The mirror: a forest write opened from inside a bare transaction.
      {
        code: tx(`await withPageForest(pageId, async (ctx) => ctx.forest());`),
        errors: [{ messageId: "poolAwait" }],
      },
      // The nested callback is judged against ITS OWN binding, so the outer
      // `ctx` does not launder a pool read inside it. (Two reports: the outer
      // `await` on the nested opener, and the pool read within it.)
      {
        code: forest(
          `await withPageForest(otherId, async (inner) => { await db.select().from(t); });`,
        ),
        errors: [{ messageId: "poolAwait" }, { messageId: "poolAwait" }],
      },
    ],
  },
);
