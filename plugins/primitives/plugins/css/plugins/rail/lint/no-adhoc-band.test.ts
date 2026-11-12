/** Tests for `rail/no-adhoc-band`. Run with `./equin test`. */
import {
  createRuleTester,
  lintToolkit,
} from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-adhoc-band";

const rule = buildRule(lintToolkit);
const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-adhoc-band", rule, {
  valid: [
    // A rule with no padding: a hairline, not a strip.
    { code: `const el = <div className="border-b" />;` },
    // Padding with no rule.
    { code: `const el = <div className="px-md py-sm" />;` },
    // The band mechanics themselves.
    { code: `const el = <div className="rail-band border-b py-sm" />;` },
    // The rail's own inset: the escape, and a follower.
    { code: `const el = <div className="border-b rail-bleed py-sm" />;` },
    { code: `const el = <div className="border-t rail-follow py-xs" />;` },
    // A side border is not a rule between strips.
    { code: `const el = <div className="border-l px-md" />;` },
    // A border width / style class is not an edge.
    { code: `const el = <div className="border-b-2 border-dashed px-md" />;` },
    // On a pseudo-element, the padding is not the element's own.
    { code: `const el = <div className="border-b after:px-md" />;` },
  ],
  invalid: [
    {
      code: `const el = <div className="border-b px-md py-sm" />;`,
      errors: [{ messageId: "adhocBand" }],
    },
    {
      code: `const el = <Line className={cn("border-t", "py-xs")} />;`,
      errors: [{ messageId: "adhocBand" }],
    },
    // Through a same-file alias.
    {
      code: `const STRIP = "border-y px-lg"; const el = <div className={STRIP} />;`,
      errors: [{ messageId: "adhocBand" }],
    },
  ],
});
