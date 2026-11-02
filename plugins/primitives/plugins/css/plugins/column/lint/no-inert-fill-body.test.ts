/**
 * Tests for the `no-inert-fill-body` lint rule. Run with `bun test` from the
 * repo root (or this file's directory).
 *
 * The rule flags a `fill`-bearing body (`<Scroll fill>` / `<Clip fill>` /
 * `<Column fill>`) passed as the `body` of a `<Column scrollBody={false}>` —
 * that mode wraps the body in a plain block div (not a flex parent), so `fill`'s
 * `min-h-0 flex-1` is inert and overflow never engages. The valid cases lock in
 * the two correct shapes: a body that owns its own height (`<Scroll
 * className="h-full">`), and Column's managed scroll body (no `scrollBody={false}`).
 */

import rule from "./no-inert-fill-body";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-inert-fill-body", rule, {
  valid: [
    // The body owns its own height — `fill` is absent; `h-full` drives the box.
    `const el = <Column scrollBody={false} body={<Scroll className="h-full" />} />;`,
    // Managed scroll body — no `scrollBody={false}`, so Column's flex Scroll
    // wrapper IS the flex parent; `fill` on a body here is irrelevant anyway.
    `const el = <Column hideScrollbar body={<FileContent />} />;`,
    // `fill` body but the (default) managed scroll body — the flex parent is real.
    `const el = <Column body={<Scroll fill />} />;`,
    // `scrollBody={false}` but the body does NOT rely on fill.
    `const el = <Column scrollBody={false} body={<Center className="h-full" />} />;`,
    // `scrollBody={true}` explicitly — the wrapper is a flex Scroll.
    `const el = <Column scrollBody={true} body={<Scroll fill />} />;`,
    // `fill={false}` is not statically truthy — nothing inert to flag.
    `const el = <Column scrollBody={false} body={<Scroll fill={false} />} />;`,
    // A non-fill-bearing body element with `scrollBody={false}`.
    `const el = <Column scrollBody={false} body={<div className="h-full" />} />;`,
  ],
  invalid: [
    // `<Scroll fill>` body inside the inert block wrapper.
    {
      code: `const el = <Column scrollBody={false} body={<Scroll fill />} />;`,
      errors: [{ messageId: "inertFillBody" }],
    },
    // `<Clip fill>` body — same inert wrapper.
    {
      code: `const el = <Column scrollBody={false} body={<Clip fill />} />;`,
      errors: [{ messageId: "inertFillBody" }],
    },
    // A nested `<Column fill>` body relies on fill too.
    {
      code: `const el = <Column scrollBody={false} body={<Column fill body={<X />} />} />;`,
      errors: [{ messageId: "inertFillBody" }],
    },
    // `fill={true}` written explicitly is still truthy.
    {
      code: `const el = <Column scrollBody={false} body={<Scroll fill={true} axis="both" />} />;`,
      errors: [{ messageId: "inertFillBody" }],
    },
  ],
});
