/**
 * Tests for the `no-unhistoried-block-field` lint rule. Run with
 * `./equin test plugins/page/plugins/editor`.
 *
 * Three axes matter, and the cases below cover all three: WHAT counts as an
 * editing surface (a raw textarea, a text-ish input, a `contenteditable` — but
 * not a checkbox, a file picker, or a component), HOW a site declares itself out
 * (the `localUndoProps` spread, or the attribute it expands to), and WHERE the
 * rule is allowed to fire (only browser code under `plugins/page/`, where the
 * block list's surface-undo declaration is overhead).
 *
 * The first invalid case is the acceptance test the rule exists for: the code
 * block's textarea as it stood — declaring nothing under a `surface` region, so
 * ⌘Z went to the document stack and the paste it should have undone stayed put.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-unhistoried-block-field";

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

/** Browser code in a page block — inside the surface-undo region, rule live. */
const INSIDE = "plugins/page/plugins/code-block/web/components/code-block.tsx";
/** Page code outside a `web/` runtime — no user types into it. */
const NON_WEB = "plugins/page/plugins/editor/core/preview.tsx";
/** Another app's browser code — no surface-undo region around its fields. */
const OUTSIDE =
  "plugins/conversations/plugins/conversation-view/web/prompt.tsx";

// `RuleTester.run` drives bun:test's ambient describe/it, so it must run at
// module top level — never wrapped in a `test()` callback.
ruleTester.run(
  "no-unhistoried-block-field",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // The transient-field answer: the marker hands ⌘Z back to the browser.
      {
        filename: INSIDE,
        code: `const a = <textarea {...localUndoProps} value={v} />;`,
      },
      {
        filename: INSIDE,
        code: `const a = <input {...localUndoProps} value={v} />;`,
      },
      // The attribute the marker expands to, written out. `resolveUndoOwner`
      // throws at runtime on a value that is neither owner, so a wrong one is
      // loud without this rule re-checking it.
      {
        filename: INSIDE,
        code: `const a = <textarea data-undo-owner="local" value={v} />;`,
      },
      {
        filename: INSIDE,
        code: `const a = <div data-undo-owner="surface" contentEditable />;`,
      },
      // The persisted-text answer. A component routes its props somewhere this
      // rule cannot see and declares at its own definition site.
      {
        filename: INSIDE,
        code: `const a = <BlockTextArea value={code} onChange={onChange} />;`,
      },
      { filename: INSIDE, code: `const a = <Input ref={inputRef} />;` },
      // Lexical's render prop — a `contentEditable` PROP on a component, not a
      // DOM attribute. This is the real shape in `block-text-editor.tsx`.
      {
        filename: INSIDE,
        code: `const a = <RichTextPlugin contentEditable={<ContentEditable />} />;`,
      },
      // No text history to protect. Marking these `local` would silence ⌘Z
      // right after ticking a checkbox — the one moment it is most wanted.
      {
        filename: INSIDE,
        code: `const a = <input type="checkbox" checked={c} onChange={t} />;`,
      },
      { filename: INSIDE, code: `const a = <input type="file" />;` },
      { filename: INSIDE, code: `const a = <input type="range" />;` },
      // A computed type may well be a checkbox — left alone for the same reason.
      { filename: INSIDE, code: `const a = <input type={kind} />;` },
      // Explicitly not an editing host.
      {
        filename: INSIDE,
        code: `const a = <div contentEditable={false}>{text}</div>;`,
      },
      { filename: INSIDE, code: `const a = <div contentEditable="false" />;` },
      // Outside a browser runtime, and outside the page app, these are ordinary.
      { filename: NON_WEB, code: `const a = <textarea value={v} />;` },
      { filename: OUTSIDE, code: `const a = <textarea value={v} />;` },
      { filename: OUTSIDE, code: `const a = <div contentEditable />;` },
    ],
    invalid: [
      // The code block's textarea as it stood: no declaration, under a region
      // that declares `surface`. This is the reported bug's routing half.
      {
        filename: INSIDE,
        code: `const a = <textarea value={code} onChange={onChange} spellCheck={false} />;`,
        errors: [
          { messageId: "unhistoriedField", data: { element: "textarea" } },
        ],
      },
      // An `<input>` with no `type` IS `type="text"`.
      {
        filename: "plugins/page/plugins/bookmark/web/components/bookmark.tsx",
        code: `const a = <input value={url} onChange={onChange} />;`,
        errors: [{ messageId: "unhistoriedField", data: { element: "input" } }],
      },
      // …and every text-ish type the browser keeps a history for.
      {
        filename: INSIDE,
        code: `const a = <input type="url" value={url} />;`,
        errors: [{ messageId: "unhistoriedField", data: { element: "input" } }],
      },
      {
        filename: INSIDE,
        code: `const a = <input type="search" value={q} />;`,
        errors: [{ messageId: "unhistoriedField", data: { element: "input" } }],
      },
      // A raw editing host on a DOM node.
      {
        filename: INSIDE,
        code: `const a = <div contentEditable suppressContentEditableWarning />;`,
        errors: [
          {
            messageId: "unhistoriedContentEditable",
            data: { element: "div" },
          },
        ],
      },
      // A spread that is NOT the marker declares nothing.
      {
        filename: INSIDE,
        code: `const a = <textarea {...rest} value={v} />;`,
        errors: [
          { messageId: "unhistoriedField", data: { element: "textarea" } },
        ],
      },
    ],
  },
);
