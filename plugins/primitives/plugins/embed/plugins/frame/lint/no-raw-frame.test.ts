/**
 * Tests for `no-raw-frame`: a raw frame element, a hand-built one and a
 * hand-written sandbox are reported; the primitive's components and look-alikes
 * are left alone.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-raw-frame";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      ecmaFeatures: { jsx: true },
    },
  },
});

const FILE = "/repo/plugins/foo/web/components/view.tsx";

ruleTester.run(
  "no-raw-frame",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
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
  },
);
