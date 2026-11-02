import rule from "./literal-icon-name";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

const IMPORT = `import { symbol, brand, seti } from "@plugins/ui/plugins/icons/core";`;

ruleTester.run("literal-icon-name", rule, {
  valid: [
    {
      code: `${IMPORT}\nconst a = symbol("forum");\nconst b = brand("github");\nconst c = seti("typescript");`,
    },
    // Type-only imports and other names from the barrel are untouched.
    {
      code: `import { type IconRef, ICON_MANIFEST } from "@plugins/ui/plugins/icons/core";\nconst x: IconRef[] = [];`,
    },
    // A `symbol` from elsewhere is not the icons one.
    { code: `import { symbol } from "./other";\nsymbol(name);` },
  ],
  invalid: [
    // Inside the icons plugin the constructors are reached relatively.
    {
      code: `import { symbol } from "../../core";\nconst a = symbol(name);`,
      filename: "/repo/plugins/ui/plugins/icons/web/internal/x.ts",
      errors: [{ messageId: "notLiteral" }],
    },
    {
      code: `${IMPORT}\nconst a = symbol(name);`,
      errors: [{ messageId: "notLiteral" }],
    },
    {
      code: `${IMPORT}\nconst a = brand(\`git\${hub}\`);`,
      errors: [{ messageId: "notLiteral" }],
    },
    {
      code: `${IMPORT}\nconst a = seti(name);`,
      errors: [{ messageId: "notLiteral" }],
    },
    {
      code: `${IMPORT}\nconst a = symbol();`,
      errors: [{ messageId: "notLiteral" }],
    },
    {
      code: `import { symbol as s } from "@plugins/ui/plugins/icons/core";\ns("forum");`,
      errors: [{ messageId: "aliased" }],
    },
    {
      code: `import * as icons from "@plugins/ui/plugins/icons/core";\nicons.symbol("forum");`,
      errors: [{ messageId: "namespace" }],
    },
    {
      code: `${IMPORT}\nconst refs = names.map(symbol);`,
      errors: [{ messageId: "notCalled" }],
    },
  ],
});
