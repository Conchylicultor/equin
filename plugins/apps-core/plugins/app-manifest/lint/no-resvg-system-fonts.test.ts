import rule from "./no-resvg-system-fonts";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();
const FILE = "/repo/plugins/foo/machine/internal/icon.ts";
const IMPORT = `import { Resvg } from "@resvg/resvg-js";`;

ruleTester.run("no-resvg-system-fonts", rule, {
  valid: [
    {
      code: `${IMPORT} new Resvg(svg, { fitTo: { mode: "width", value: 64 }, font: { loadSystemFonts: false } });`,
      filename: FILE,
    },
    {
      code: `${IMPORT} new Resvg(svg, { font: { "loadSystemFonts": false, fontFiles: ["a.ttf"] } });`,
      filename: FILE,
    },
    // Another module's Resvg is not resvg-js.
    { code: `import { Resvg } from "./mine"; new Resvg(svg);`, filename: FILE },
  ],
  invalid: [
    {
      code: `${IMPORT} new Resvg(svg);`,
      filename: FILE,
      errors: [{ messageId: "systemFonts" }],
    },
    {
      code: `${IMPORT} new Resvg(svg, { fitTo: { mode: "width", value: 64 } });`,
      filename: FILE,
      errors: [{ messageId: "systemFonts" }],
    },
    {
      code: `${IMPORT} new Resvg(svg, { font: { loadSystemFonts: true } });`,
      filename: FILE,
      errors: [{ messageId: "systemFonts" }],
    },
    // Options from a variable cannot be read here: spell them inline.
    {
      code: `${IMPORT} new Resvg(svg, opts);`,
      filename: FILE,
      errors: [{ messageId: "systemFonts" }],
    },
    {
      code: `import * as r from "@resvg/resvg-js"; new r.Resvg(svg);`,
      filename: FILE,
      errors: [{ messageId: "systemFonts" }],
    },
    {
      code: `import { Resvg as R } from "@resvg/resvg-js"; new R(svg, {});`,
      filename: FILE,
      errors: [{ messageId: "systemFonts" }],
    },
  ],
});
