/**
 * Tests for the `no-ready-negation` lint rule: on a resource result, `status`
 * may be compared to "loading" / "error" and switched over, but a "not ready"
 * test — `!== "ready"`, or `=== "ready"` as a ternary's test — folds loading and
 * error into one state and is flagged. Untainted objects and test code are left
 * alone.
 */

import rule from "./no-ready-negation";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-ready-negation", rule, {
  valid: [
    // Naming the non-ready states is the point.
    {
      code: `
          const r = useLive(rows);
          if (r.status === "loading") return <Loading />;
          if (r.status === "error") return <ResourceErrorInline error={r.error} variant="block" />;
        `,
      },
      // An explicit switch fall-through names both states.
      {
        code: `
          function f() {
            const r = useResource(songs);
            switch (r.status) {
              case "loading":
              case "error":
                return null;
              case "ready":
                return r.data;
            }
          }
        `,
      },
      // `=== "ready"` outside a ternary test (an if, a filter) is fine.
      {
        code: `
          const r = useLive(rows);
          if (r.status === "ready") log(r.data);
          const ok = r.status === "ready" && r.data.length > 0;
        `,
      },
      // Not a resource result: a domain object with its own status.
      {
        code: `
          const job = getJob();
          const label = job.status !== "ready" ? "waiting" : "go";
        `,
      },
      // Test code is exempt.
      {
        filename: "/repo/plugins/x/web/__tests__/x.test.tsx",
        code: `
          const r = useLive(rows);
          if (r.status !== "ready") throw new Error("unreachable");
        `,
      },
    ],
    invalid: [
      {
        code: `
          const r = useLive(rows);
          if (r.status !== "ready") return <Loading />;
        `,
        errors: [{ messageId: "readyNegation" }],
      },
      {
        code: `
          const r = useResource(songs);
          const rows = r.status === "ready" ? r.data : [];
        `,
        errors: [{ messageId: "readyTernary" }],
      },
      // Reversed operands.
      {
        code: `
          const all = combineResources({ a, b });
          const busy = "ready" != all.status;
        `,
        errors: [{ messageId: "readyNegation" }],
      },
      // A parameter typed as a result.
      {
        code: `
          function Row({ r }: { r: never }, q: LiveListResult<Item>) {
            return q.status === "ready" ? <List rows={q.data} /> : <Loading />;
          }
        `,
        errors: [{ messageId: "readyTernary" }],
      },
      // A destructured status.
      {
        code: `
          const { status } = useLive(tasks, { id });
          const spin = status !== "ready";
        `,
        errors: [{ messageId: "readyNegation" }],
      },
    ],
  },
);
