/**
 * Tests for the `no-button-shadow` lint rule. Run with `./equin test`.
 *
 * The rule reports a `shadow-*` in the class names of a `<Button>` /
 * `<IconButton>` — a floating button must be `variant="floating"`, whose fill
 * is solid. The cases locked in: a shadow reached through `cn()` or a hoisted
 * const still trips; `shadow-none` and shadow colours do not; a shadow on a
 * non-button element is not this rule's business.
 */

// The rule is a FACTORY taking the shared class-token walk (rule files cannot
// import it — they dual-load under jiti). Tests run under Bun, where the
// `@plugins/*` alias resolves, so they construct it with the real toolkit.
import {
  createRuleTester,
  lintToolkit,
} from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-button-shadow";

const rule = buildRule(lintToolkit);

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-button-shadow", rule, {
  valid: [
    { code: `const el = <Button variant="floating">Fit</Button>;` },
    { code: `const el = <Button className="shadow-none">x</Button>;` },
    { code: `const el = <Button className="shadow-black/20">x</Button>;` },
    { code: `const el = <div className="shadow-md">x</div>;` },
    { code: `const el = <CopyButton className="shadow-md" />;` },
  ],
  invalid: [
    {
      code: `const el = <Button variant="outline" className="shadow-md">x</Button>;`,
      errors: [{ messageId: "buttonShadow" }],
    },
    {
      code: `const el = <IconButton className={cn("rounded-full", "shadow")} />;`,
      errors: [{ messageId: "buttonShadow" }],
    },
    {
      code: `const C = "hover:shadow-lg"; const el = <Button className={C}>x</Button>;`,
      errors: [{ messageId: "buttonShadow" }],
    },
    {
      code: `const el = <Button className="shadow-[0_1px_2px_black]">x</Button>;`,
      errors: [{ messageId: "buttonShadow" }],
    },
  ],
});
