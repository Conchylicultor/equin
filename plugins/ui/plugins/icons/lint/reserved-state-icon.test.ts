import rule from "./reserved-state-icon";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const IMPORT = `import { symbol, stateIcons } from "@plugins/ui/plugins/icons/core";`;

ruleTester.run("reserved-state-icon", rule, {
  valid: [
    {
      code: `${IMPORT}\nconst a = symbol("check-circle");\nconst b = stateIcons.working;`,
    },
    // A `symbol` from elsewhere is not the icons one.
    { code: `import { symbol } from "./other";\nsymbol("front-hand");` },
  ],
  invalid: [
    {
      code: `${IMPORT}\nconst a = symbol("progress-activity");`,
      errors: [{ messageId: "reserved" }],
    },
    {
      code: `${IMPORT}\nconst a = symbol("front-hand");`,
      errors: [{ messageId: "reserved" }],
    },
    {
      code: `${IMPORT}\nconst a = symbol("incomplete-circle");`,
      errors: [{ messageId: "reserved" }],
    },
  ],
});
