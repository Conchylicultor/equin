import rule from "./no-rss-memory";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-rss-memory", rule, {
  valid: [
    { code: `const r = readProcRusage(process.pid);` },
    { code: `const { heapUsed } = process.memoryUsage();` },
    { code: `const cpu = process.resourceUsage().userCPUTime;` },
    // A `ps` row's own field: not a memoryUsage() read.
    { code: `const mb = row.rss / 1024;` },
    { code: `const doc = "never read maxRSS";` },
  ],
  invalid: [
    {
      code: `const peak = process.resourceUsage().maxRSS;`,
      errors: [{ messageId: "rss" }],
    },
    {
      code: `const peak = proc.resourceUsage()?.maxRSS;`,
      errors: [{ messageId: "rss" }],
    },
    {
      code: `const now = process.memoryUsage().rss;`,
      errors: [{ messageId: "rss" }],
    },
    {
      code: `const { rss } = process.memoryUsage();`,
      errors: [{ messageId: "rss" }],
    },
    {
      code: `const { maxRSS } = usage;`,
      errors: [{ messageId: "rss" }],
    },
  ],
});
