/**
 * Tests for `no-raw-frame`: a raw frame element, a hand-built one and a
 * hand-written sandbox are reported; the primitive's components and look-alikes
 * are left alone.
 */

import rule from "./no-raw-frame";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

const FILE = "/repo/plugins/foo/web/components/view.tsx";

ruleTester.run("no-raw-frame", rule, {
  valid: [
    { code: `<ContentFrame src={src} title="x" />;`, filename: FILE },
    { code: `<AppFrame path="/agents" title="x" />;`, filename: FILE },
    { code: `<div className="iframe" />;`, filename: FILE },
    { code: `document.createElement("div");`, filename: FILE },
    { code: `el.src = url;`, filename: FILE },
    { code: `const html = "<iframe src=x></iframe>";`, filename: FILE },
  ],
  invalid: [
    {
      code: `<iframe src={url} sandbox="allow-scripts allow-same-origin" />;`,
      filename: FILE,
      errors: [{ messageId: "rawFrame" }],
    },
    {
      code: `<iframe src={url}></iframe>;`,
      filename: FILE,
      errors: [{ messageId: "rawFrame" }],
    },
    {
      code: `<object data={url} />;`,
      filename: FILE,
      errors: [{ messageId: "rawFrame" }],
    },
    {
      code: `<embed src={url} />;`,
      filename: FILE,
      errors: [{ messageId: "rawFrame" }],
    },
    {
      code: `document.createElement("IFRAME");`,
      filename: FILE,
      errors: [{ messageId: "rawFrame" }],
    },
    {
      code: `frame.srcdoc = html;`,
      filename: FILE,
      errors: [{ messageId: "frameProp" }],
    },
    {
      code: `frame.sandbox = "";`,
      filename: FILE,
      errors: [{ messageId: "frameProp" }],
    },
  ],
});
