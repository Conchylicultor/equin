/**
 * Tests for the `no-adhoc-scroll-write` lint rule. Run with `bun test`.
 *
 * The rule bans raw scroll WRITES outside the scroll-owning primitives:
 * `el.scrollTop = …` / `el.scrollLeft = …` assignments and `el.scrollTo(…)` /
 * `el.scrollBy(…)` calls. Reads of `scrollTop`/`scrollLeft` (assignment sources,
 * not targets) and unrelated `.scrollToTop()`-style calls stay valid.
 */

import rule from "./no-adhoc-scroll-write";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-adhoc-scroll-write", rule, {
  valid: [
    // A read of scrollTop is an assignment source, not a target.
    { code: `const t = el.scrollTop;` },
    // A pin-distance computation reads scrollTop mid-expression.
    {
      code: `const d = el.scrollHeight - el.scrollTop - el.clientHeight;`,
    },
    // An unrelated method whose name merely starts with `scrollTo`.
    { code: `foo.scrollToTop();` },
  ],
  invalid: [
    // scrollTop write.
    {
      code: `el.scrollTop = h;`,
      errors: [{ messageId: "adhocScrollWrite" }],
    },
    // scrollLeft write (horizontal).
    {
      code: `el.scrollLeft = w;`,
      errors: [{ messageId: "adhocScrollWrite" }],
    },
    // scrollTo call.
    {
      code: `el.scrollTo({ top: 0 });`,
      errors: [{ messageId: "adhocScrollWrite" }],
    },
    // scrollBy call.
    {
      code: `el.scrollBy(0, 10);`,
      errors: [{ messageId: "adhocScrollWrite" }],
    },
  ],
});
