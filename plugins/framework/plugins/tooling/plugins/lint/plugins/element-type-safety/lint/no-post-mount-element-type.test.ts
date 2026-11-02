/**
 * Tests for the `no-post-mount-element-type` lint rule. Run with `bun test`
 * from the repo root (or this file's directory).
 *
 * The rule flags a ternary `state ? <A>{kids}</A> : <B>{kids}</B>` that wraps
 * IDENTICAL, non-empty children in DIFFERENT JSX element TYPES, where `state` is
 * a `useState` whose setter is called ONLY inside useEffect/useLayoutEffect
 * callbacks — a guaranteed post-mount remount of a stable subtree.
 *
 * It must fire on wrapper-type swaps around identical children (fragment vs
 * element, different host tags, different components) but never on:
 *   - same-type ternaries (the prescribed fix),
 *   - DIFFERENT children per branch (loading vs error, plain vs highlighted),
 *   - empty-children component swaps (`<Skeleton/>` vs `<Content/>`),
 *   - conditional mount/unmount (`? <A/> : null`),
 *   - state that is also set outside an effect, or whose setter is untraceable,
 *   - prop-driven ternaries (no useState).
 */

import rule from "./no-post-mount-element-type";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-post-mount-element-type", rule, {
  valid: [
    // Same element type both branches — this is exactly the prescribed fix.
    {
      code: `
          function C() {
            const [horizontal, setHorizontal] = useState(false);
            useLayoutEffect(() => { setHorizontal(true); }, []);
            return horizontal
              ? <div className="flex">{kids}</div>
              : <div className="contents">{kids}</div>;
          }
        `,
      },
      // DIFFERENT children per branch — legit conditional rendering, NOT a
      // wrapper swap (mirrors bookmark-block: loading vs error).
      {
        code: `
          function C() {
            const [error, setError] = useState(null);
            useEffect(() => { setError(getError()); }, []);
            return error
              ? <Placeholder tone="error">{error}</Placeholder>
              : <Loading variant="text" label="Loading" />;
          }
        `,
      },
      // DIFFERENT children per branch (mirrors code-block: plain vs highlighted).
      {
        code: `
          function C() {
            const [html, setHtml] = useState("");
            useEffect(() => { setHtml(highlight(code)); }, []);
            return html
              ? <div dangerouslySetInnerHTML={{ __html: html }} />
              : <pre>{code || " "}</pre>;
          }
        `,
      },
      // Empty-children component swap (common SSR mount pattern) — not flagged.
      {
        code: `
          function C() {
            const [mounted, setMounted] = useState(false);
            useEffect(() => { setMounted(true); }, []);
            return mounted ? <Content /> : <Skeleton />;
          }
        `,
      },
      // Conditional mount/unmount, not a type swap.
      {
        code: `
          function C() {
            const [ready, setReady] = useState(false);
            useEffect(() => { setReady(true); }, []);
            return ready ? <Panel /> : null;
          }
        `,
      },
      // Setter ALSO called in an onClick handler — not effect-only.
      {
        code: `
          function C() {
            const [open, setOpen] = useState(false);
            useEffect(() => { setOpen(true); }, []);
            return (
              <button onClick={() => setOpen(true)}>
                {open ? <div>{kids}</div> : <span>{kids}</span>}
              </button>
            );
          }
        `,
      },
      // Setter passed as a value (untraceable) — favor false negative.
      {
        code: `
          function C() {
            const [open, setOpen] = useState(false);
            useEffect(() => { setOpen(true); }, []);
            return (
              <Child onChange={setOpen}>
                {open ? <div>{kids}</div> : <span>{kids}</span>}
              </Child>
            );
          }
        `,
      },
      // State used in a BRANCH, not the test — not the choosing condition.
      {
        code: `
          function C() {
            const [label, setLabel] = useState("a");
            useEffect(() => { setLabel("b"); }, []);
            return cond ? <div>{label}</div> : <span>{label}</span>;
          }
        `,
      },
      // Prop-driven ternary (no useState at all) — out of scope.
      {
        code: `
          function C({ horizontal }) {
            return horizontal ? <div className="flex">{kids}</div> : <>{kids}</>;
          }
        `,
      },
      // Plain useState set in an event handler only (never in an effect).
      {
        code: `
          function C() {
            const [open, setOpen] = useState(false);
            return (
              <button onClick={() => setOpen((v) => !v)}>
                {open ? <div>{kids}</div> : <span>{kids}</span>}
              </button>
            );
          }
        `,
      },
      // useState never flips (no setter call site) — never remounts.
      {
        code: `
          function C() {
            const [horizontal] = useState(false);
            return horizontal ? <div>{kids}</div> : <span>{kids}</span>;
          }
        `,
      },
    ],
    invalid: [
      // The canonical bug: false flipped in useLayoutEffect, element vs
      // Fragment-component, IDENTICAL children.
      {
        code: `
          function C() {
            const [horizontal, setHorizontal] = useState(false);
            useLayoutEffect(() => { setHorizontal(true); }, []);
            return horizontal
              ? <div className="flex">{kids}</div>
              : <Fragment>{kids}</Fragment>;
          }
        `,
        errors: [{ messageId: "postMountElementType" }],
      },
      // The `<>` empty-fragment-tag form, IDENTICAL children.
      {
        code: `
          function C() {
            const [horizontal, setHorizontal] = useState(false);
            useLayoutEffect(() => { setHorizontal(true); }, []);
            return horizontal ? <div className="flex">{kids}</div> : <>{kids}</>;
          }
        `,
        errors: [{ messageId: "postMountElementType" }],
      },
      // Different host tags, IDENTICAL children.
      {
        code: `
          function C() {
            const [wide, setWide] = useState(false);
            useEffect(() => { setWide(true); }, []);
            return wide ? <div>{kids}</div> : <span>{kids}</span>;
          }
        `,
        errors: [{ messageId: "postMountElementType" }],
      },
      // Different components, IDENTICAL children.
      {
        code: `
          function C() {
            const [ready, setReady] = useState(false);
            useEffect(() => { setReady(true); }, []);
            return ready ? <Foo>{kids}</Foo> : <Bar>{kids}</Bar>;
          }
        `,
        errors: [{ messageId: "postMountElementType" }],
      },
      // `!state` test form, IDENTICAL children.
      {
        code: `
          function C() {
            const [horizontal, setHorizontal] = useState(false);
            useLayoutEffect(() => { setHorizontal(true); }, []);
            return !horizontal
              ? <Fragment>{kids}</Fragment>
              : <div className="flex">{kids}</div>;
          }
        `,
        errors: [{ messageId: "postMountElementType" }],
      },
      // Setter called inside a listener/observer created INSIDE the effect —
      // still post-mount.
      {
        code: `
          function C() {
            const [wide, setWide] = useState(false);
            useEffect(() => {
              const ro = new ResizeObserver(() => { setWide(true); });
              ro.observe(el);
              return () => ro.disconnect();
            }, []);
            return wide ? <div>{kids}</div> : <span>{kids}</span>;
          }
        `,
        errors: [{ messageId: "postMountElementType" }],
      },
    ],
  },
);
