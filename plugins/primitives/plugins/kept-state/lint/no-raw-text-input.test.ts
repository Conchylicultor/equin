/**
 * Tests for `no-raw-text-input`: raw text fields and contentEditable are
 * reported; the primitives and non-text inputs are left alone.
 */

import rule from "./no-raw-text-input";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

const FILE = "/repo/plugins/foo/web/components/view.tsx";

ruleTester.run("no-raw-text-input", rule, {
  valid: [
    { code: `<Input keep={draft} />;`, filename: FILE },
    {
      code: `<Textarea keep={transient("x")} value={v} onChange={f} />;`,
      filename: FILE,
    },
    { code: `<input type="checkbox" checked={c} />;`, filename: FILE },
    { code: `<input type="file" />;`, filename: FILE },
    { code: `<input type={"range"} />;`, filename: FILE },
    { code: `<div contentEditable={false} />;`, filename: FILE },
    { code: `<span contentEditable="false" />;`, filename: FILE },
    {
      code: `<PlainTextPlugin contentEditable={<ContentEditable />} />;`,
      filename: FILE,
    },
  ],
  invalid: [
    {
      code: `<input value={v} />;`,
      filename: FILE,
      errors: [{ messageId: "rawField" }],
    },
    {
      code: `<input type="text" />;`,
      filename: FILE,
      errors: [{ messageId: "rawField" }],
    },
    {
      code: `<input type="search" />;`,
      filename: FILE,
      errors: [{ messageId: "rawField" }],
    },
    {
      code: `<input type={kind} />;`,
      filename: FILE,
      errors: [{ messageId: "rawField" }],
    },
    {
      code: `<textarea value={v} />;`,
      filename: FILE,
      errors: [{ messageId: "rawField" }],
    },
    {
      code: `<div contentEditable />;`,
      filename: FILE,
      errors: [{ messageId: "contentEditable" }],
    },
    {
      code: `<div contentEditable={editing} />;`,
      filename: FILE,
      errors: [{ messageId: "contentEditable" }],
    },
  ],
});
