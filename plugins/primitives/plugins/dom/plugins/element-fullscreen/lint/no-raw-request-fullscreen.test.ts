import rule from "./no-raw-request-fullscreen";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();
const FILE = "/repo/plugins/foo/web/components/x.tsx";

ruleTester.run("no-raw-request-fullscreen", rule, {
  valid: [
    {
      code: `const fs = fullscreenSupport(); if (fs.kind === "supported") void fs.request(el);`,
      filename: FILE,
    },
    { code: `void document.exitFullscreen();`, filename: FILE },
  ],
  invalid: [
    {
      code: `void el.requestFullscreen();`,
      filename: FILE,
      errors: [{ messageId: "noRawRequestFullscreen" }],
    },
    {
      code: `void document.documentElement.requestFullscreen();`,
      filename: FILE,
      errors: [{ messageId: "noRawRequestFullscreen" }],
    },
    {
      code: `void el["requestFullscreen"]();`,
      filename: FILE,
      errors: [{ messageId: "noRawRequestFullscreen" }],
    },
  ],
});
