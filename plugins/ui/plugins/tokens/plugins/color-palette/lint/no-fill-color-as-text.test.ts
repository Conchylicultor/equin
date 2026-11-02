import {
  createRuleTester,
  lintToolkit,
} from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-fill-color-as-text";

const rule = buildRule(lintToolkit);

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-fill-color-as-text", rule, {
  valid: [
    {
      code: `const C = () => <span className="text-primary-text text-success" />;`,
    },
    {
      code: `const C = () => <span className="hover:text-destructive/80" />;`,
    },
    {
      code: `const C = () => <button className="bg-primary text-primary-foreground" />;`,
    },
    { code: `const note = "never text-primary";` },
  ],
  invalid: [
    {
      code: `const C = () => <span className="text-primary" />;`,
      errors: [{ messageId: "fillAsText" }],
    },
    {
      code: `const v = cva("hover:text-primary/70");`,
      errors: [{ messageId: "fillAsText" }],
    },
    {
      code: `const T = { e: "text-primary" }; const C = () => <p className={cn(T.e)} />;`,
      errors: [{ messageId: "fillAsText" }, { messageId: "fillAsText" }],
    },
  ],
});
