import rule from "./no-raw-request-picture-in-picture";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();
const FILE = "/repo/plugins/foo/web/components/x.tsx";

ruleTester.run("no-raw-request-picture-in-picture", rule, {
  valid: [
    {
      code: `const s = videoPipSupport(); if (s.kind === "supported") void s.request(v);`,
      filename: FILE,
    },
    { code: `void document.exitPictureInPicture();`, filename: FILE },
  ],
  invalid: [
    {
      code: `void video.requestPictureInPicture();`,
      filename: FILE,
      errors: [{ messageId: "noRawRequestPip" }],
    },
    {
      code: `void video["requestPictureInPicture"]();`,
      filename: FILE,
      errors: [{ messageId: "noRawRequestPip" }],
    },
  ],
});
