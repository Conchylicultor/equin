/**
 * Tests for the `no-clock-in-served` lint rule: a clock read inside a served
 * live read's arguments.
 */

import rule from "./no-clock-in-served";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const clock = { messageId: "clock" as const };

ruleTester.run("no-clock-in-served", rule, {
  valid: [
    // A pinned param, read by the loader.
    {
      code:
        "serveValue(v, { source: 'db', loader: ({ today }) => db.execute(sql`select * from t where day > ${" +
        "today}::date - 7`) });",
    },
    // A date built FROM data is no clock read.
    { code: "serveValue(v, { loader: (p) => new Date(p.at) });" },
    // Outside a served read.
    { code: "const t = Date.now(); const d = new Date();" },
    { code: "const q = sql`select now()`;" },
    // A call that only shares a name.
    { code: "serveThing(v, { loader: () => Date.now() });" },
  ],
  invalid: [
    { code: "serveValue(v, { loader: () => Date.now() });", errors: [clock] },
    {
      code: "serveValue(v, { loader: () => billingMonth(new Date()) });",
      errors: [clock],
    },
    {
      code: "serveValue(v, { source: 'db', loader: () => db.execute(sql`select * from t where day > current_date - 7`) });",
      errors: [clock],
    },
    {
      code: "serveCollection(c, { from: t, where: sql`started_at > now() - interval '1 day'` });",
      errors: [clock],
    },
    {
      code: "live.serveValueOn(rt, v, { loader: async () => ({ at: Date.now() }) }, opts);",
      errors: [clock],
    },
  ],
});
