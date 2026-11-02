/**
 * Tests for the `no-hand-rolled-entity-projection` lint rule. Run with
 * `./equin test plugins/framework/plugins/tooling/plugins/lint/plugins/entity-projection-safety`.
 *
 * The rule flags an all-pure identity `.map` over a `db.select().from(…)` chain
 * inside a resource loader — the `loader` property of `defineResource(…)` or of
 * network/live's `serveValue(value, { … })`, either arm. A genuine transform, a
 * loader passed by reference, and a projection outside the `loader` property are
 * all left alone (the rule favours false negatives).
 */

import rule from "./no-hand-rolled-entity-projection";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const error = { messageId: "handRolledProjection" as const };

ruleTester.run("no-hand-rolled-entity-projection", rule, {
  valid: [
    // A genuine transform (`?? null`) is not an identity projection.
    {
      code: `export const served = serveValue(v, {
          source: "db",
          loader: async () => {
            const rows = await db.select().from(_t);
            return rows.map((r) => ({ id: r.id, note: r.note ?? null }));
          },
        });`,
      },
      // Rows returned verbatim — the fix the rule points at.
      {
        code: `export const served = serveValue(v, {
          source: "db",
          loader: async () => db.select().from(entity.table),
        });`,
      },
      // A loader passed by reference is not followed.
      {
        code: `async function loadRows() {
          const rows = await db.select().from(_t);
          return rows.map((r) => ({ id: r.id, name: r.name }));
        }
        export const served = serveValue(v, { source: "db", loader: loadRows });`,
      },
      // Inside the call, but not in its `loader` property.
      {
        code: `export const served = serveValue(v, {
          source: "external",
          loader: () => readState(),
          revalidate: async () =>
            (await db.select().from(_t)).map((r) => ({ id: r.id })),
        });`,
      },
      // A `loader` of some other call is not a resource loader.
      {
        code: `defineEndpoint(ep, {
          loader: async () => (await db.select().from(_t)).map((r) => ({ id: r.id })),
        });`,
      },
      // The receiver is not a `db.select()` chain.
      {
        code: `serveValue(v, {
          source: "external",
          loader: async () => (await readAll()).map((r) => ({ id: r.id })),
        });`,
      },
    ],
    invalid: [
      // The flat old form.
      {
        code: `export const res = defineResource({
          key: "k",
          mode: "push",
          loader: async () => {
            const rows = await db.select().from(_t);
            return rows.map((r) => ({ id: r.id, name: r.name }));
          },
        });`,
        errors: [error],
      },
      // The 2-arg old form.
      {
        code: `defineResource(desc, {
          mode: "push",
          loader: async () => (await db.select().from(_t)).map((r) => ({ id: r.id })),
        });`,
        errors: [error],
      },
      // serveValue, db arm, two-statement form with a Date → ISO copy.
      {
        code: `export const served = serveValue(v, {
          source: "db",
          loader: async () => {
            const rows = await db.select().from(_t).orderBy(_t.createdAt);
            return rows.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString() }));
          },
        });`,
        errors: [error],
      },
      // serveValue, external arm, inline form with a cast.
      {
        code: `export const served = serveValue(v, {
          source: "external",
          loader: async ({ id }) =>
            (await db.select().from(_t).where(eq(_t.id, id))).map((r) => ({ id: r.id as string })),
        });`,
        errors: [error],
      },
      // A member-form callee.
      {
        code: `live.serveValue(v, {
          source: "db",
          loader: async function () {
            const rows = await db.select().from(_t);
            return rows.map(function (r) { return { id: r.id }; });
          },
        });`,
        errors: [error],
      },
    ],
  },
);
