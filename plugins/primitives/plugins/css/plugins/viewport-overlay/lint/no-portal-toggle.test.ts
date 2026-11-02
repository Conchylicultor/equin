/**
 * Tests for the `no-portal-toggle` lint rule. Run with `bun test` from the repo
 * root (or this file's directory).
 *
 * The rule catches the three spellings of "a portal behind a condition": the
 * ternary, the multi-return function, and the conditional container argument.
 * `null` / `undefined` / `false` on the other path stay valid — a genuine
 * mount/unmount is an honest intent — and the check is shallow, so an ordinary
 * conditional that merely CONTAINS a portal deeper in a JSX subtree is left
 * alone.
 */

import rule from "./no-portal-toggle";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-portal-toggle", rule, {
  valid: [
    // Unconditional: the only shape that keeps its subtree.
    `const a = createPortal(children, document.body);`,
    // A genuine mount/unmount — nothing is being replaced.
    `const a = open ? createPortal(children, document.body) : null;`,
    `const a = open ? null : createPortal(children, document.body);`,
    `const a = open ? createPortal(children, document.body) : undefined;`,
    `const a = open ? createPortal(children, document.body) : false;`,
    // `cond && portal` renders nothing when false — same honest intent.
    `const a = open && createPortal(children, document.body);`,
    // Early-out that renders nothing, then a portal.
    `function C() { if (!open) return null; return createPortal(children, document.body); }`,
    // A conditional that merely CONTAINS a portal deep in a JSX subtree: the
    // portal is not the thing being swapped, so the shallow check ignores it.
    `const a = open ? <div><Overlay>{createPortal(children, document.body)}</Overlay></div> : <div />;`,
    // Two ordinary element branches, no portal at all.
    `function C() { if (!open) return <>{children}</>; return <div>{children}</div>; }`,
    // A stable container held in a variable is exactly the sanctioned answer.
    `const a = createPortal(children, containerRef.current);`,
    // Nested function boundary: the portal return and the element return
    // belong to different functions.
    `function C() { const Inner = () => createPortal(children, host); return <div><Inner /></div>; }`,
  ],
  invalid: [
    // Spelling 1 — the ternary (apps-core/surface's shape).
    {
      code: `const a = portalToBody ? createPortal(container, document.body) : container;`,
      errors: [{ messageId: "portalToggle" }],
    },
    // …with the portal on the other side, and a JSX element opposite it.
    {
      code: `const a = solo ? <div>{children}</div> : createPortal(children, document.body);`,
      errors: [{ messageId: "portalToggle" }],
    },
    // Spelling 2 — the multi-return function (ViewportOverlay's own shape),
    // which a ternary-only rule misses entirely.
    {
      code: `function O({ active, children }) { if (!active) return <>{children}</>; return createPortal(<div>{children}</div>, document.body); }`,
      errors: [{ messageId: "portalToggle" }],
    },
    // Same across an arrow function with a block body.
    {
      code: `const O = ({ active, children }) => { if (active) { return createPortal(children, document.body); } return children; };`,
      errors: [{ messageId: "portalToggle" }],
    },
    // Spelling 3 — the container argument itself changes.
    {
      code: `const a = createPortal(children, inPanel ? panel : row);`,
      errors: [{ messageId: "portalContainer" }],
    },
    // A `??` fallback container is still a container that can change.
    {
      code: `const a = createPortal(children, host ?? document.body);`,
      errors: [{ messageId: "portalContainer" }],
    },
    // Namespaced import spelling is the same call.
    {
      code: `const a = open ? ReactDOM.createPortal(children, document.body) : <div />;`,
      errors: [{ messageId: "portalToggle" }],
    },
  ],
});
