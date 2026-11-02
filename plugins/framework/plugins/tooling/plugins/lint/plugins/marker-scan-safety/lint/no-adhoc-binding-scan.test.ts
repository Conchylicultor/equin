/**
 * Tests for the `no-adhoc-binding-scan` lint rule. Run with `bun test`.
 *
 * The rule flags a GLOBAL regex literal that hand-rolls a `const <name> =
 * <call>(` marker-binding scan (the shape `markerCallSpans` centralizes). It
 * fires only when a literal `const … =` binding reaches a named call's LITERAL
 * `\(`; a non-global regex, an object-literal binding (`= { … }`), a `.table`
 * alias (no `\(`), a bare capture-group `(`, or a call-scan with no `const …=`
 * binding (e.g. the sanctioned masked dynamic-`import(` scanner) all stay valid.
 */

import rule from "./no-adhoc-binding-scan";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-adhoc-binding-scan", rule, {
  valid: [
    // Non-global: an anchored preceding-`const … =$` decl matcher over one
    // already-located call is not a whole-file scan.
    String.raw`const decl = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*$/;`,
    // Non-global binding-call parser is out of scope (the `g` flag is the tell).
    String.raw`const r = /const\s+(\w+)\s*=\s*pgTable\s*\(/;`,
    // Object-literal binding (`= { … }`) — no named call `\(`.
    String.raw`const groupRe = /export\s+const\s+([A-Z]\w*)\s*=\s*\{/g;`,
    // `.table` alias construct detector — no `\(`, safe over masked source.
    String.raw`const aliasRe = /(?:export\s+)?const\s+(\w+)\s*=\s*(\w+)\.table\b/g;`,
    // Binding to a bare identifier — a capture group `(` is not a call `\(`.
    String.raw`const r = /const\s+(\w+)\s*=\s*(\w+)/g;`,
    // The sanctioned masked dynamic-`import(` scanner: a call `\(` but NO
    // `const … =` binding, so it is not a binding scan.
    String.raw`const re = /\bimport\s*\(\s*(["'` + "`" + String.raw`])/g;`,
  ],
  invalid: [
    // `const X = pgTable("…")` — the db-schema table scanner.
    {
      code: String.raw`const pgRe = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*pgTable\s*\(\s*["']([^"']+)["']/g;`,
      errors: [{ messageId: "adhocBindingScan" }],
    },
    // `const X = defineEntity("…")` — the entity scanner.
    {
      code: String.raw`const entityRe = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*defineEntity\s*\(\s*["']([^"']+)["']/g;`,
      errors: [{ messageId: "adhocBindingScan" }],
    },
    // `const X = Pane.define({ … })` — dotted marker, object arg.
    {
      code: String.raw`const re = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*Pane\.define\s*\(\s*\{/g;`,
      errors: [{ messageId: "adhocBindingScan" }],
    },
    // `const X = defineEndpoint(` — the routes endpoint scanner.
    {
      code: String.raw`const exportRe = /export\s+const\s+(\w+)\s*=\s*defineEndpoint\s*\(/g;`,
      errors: [{ messageId: "adhocBindingScan" }],
    },
  ],
});
