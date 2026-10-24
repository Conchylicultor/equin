/**
 * Tests for the `no-render-phase-peek` lint rule. Run with
 * `./equin test plugins/primitives/plugins/install-sink`.
 *
 * The rule bans a `peek…()` call that executes during React render. It must NOT
 * fire from a deferred boundary (an effect callback, a `useCallback`, a closure
 * returned from a `useMemo`, an `onClick` prop), from a plain non-React module
 * function, on a member READ that is not a call, or on a name that merely starts
 * with the letters "peek" without a word boundary (`peeking()`).
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-render-phase-peek";

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

// `RuleTester.run` drives the test harness itself (it calls the ambient
// describe/it that bun:test provides), so it must run at module top level —
// never wrapped in a `test()` callback.
ruleTester.run(
  "no-render-phase-peek",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // Effect callback — runs after installation, and re-runs.
      {
        code: `
        function ExpandButton() {
          useEffect(() => {
            const nav = appNavSink.peek();
            if (nav) nav("/x");
          }, []);
          return null;
        }
      `,
      },
      // useCallback — deferred to invocation time.
      {
        code: `
        function ExpandButton() {
          const go = useCallback((url) => appNavSink.peekOrThrow()(url), []);
          return go;
        }
      `,
      },
      // A closure RETURNED from a useMemo — the peek runs when the closure is
      // called, not while the memo computes.
      {
        code: `
        function ExpandButton() {
          const go = useMemo(() => () => appNavSink.peek(), []);
          return go;
        }
      `,
      },
      // onClick prop inside JSX.
      {
        code: `
        function ExpandButton() {
          return <button onClick={() => appNavSink.peekOrThrow()("/x")} />;
        }
      `,
      },
      // Plain, non-React module function: no component/hook boundary is ever
      // reached, so the walk hits Program and stops.
      {
        code: `
        function resolveNavigator() {
          return appNavSink.peek();
        }
      `,
      },
      // A member READ, not a call.
      {
        code: `
        function ExpandButton() {
          const value = appNavSink.peeked;
          return value;
        }
      `,
      },
      // `peeking()` — the name test requires a word boundary after "peek", so an
      // ordinary verb that merely begins with those letters is NOT flagged.
      // Deliberate: a prefix test would sweep in unrelated English.
      {
        code: `
        function ExpandButton() {
          const v = tracker.peeking();
          return v;
        }
      `,
      },
      // Nested non-React helper declared inside a component: the helper's own
      // boundary is deferred (it is not invoked during render by anything the
      // whitelist recognises).
      {
        code: `
        function ExpandButton() {
          function later() { return appNavSink.peek(); }
          return later;
        }
      `,
      },
    ],
    invalid: [
      // The direct case: a bare call in a component body, ZERO intermediate
      // functions.
      {
        code: `
        function ExpandButton() {
          const away = appNavSink.peek() !== null;
          return away;
        }
      `,
        errors: [{ messageId: "renderPhasePeek" }],
      },
      // The original incident's shape: inside a useMemo.
      {
        code: `
        const ExpandButton = () => {
          return useMemo(() => {
            return appNavSink.peek() !== null;
          }, [store]);
        };
      `,
        errors: [{ messageId: "renderPhasePeek" }],
      },
      // useState lazy initializer — runs during the first render.
      {
        code: `
        function ExpandButton() {
          const [nav] = useState(() => appNavSink.peek());
          return nav;
        }
      `,
        errors: [{ messageId: "renderPhasePeek" }],
      },
      // useReducer's third argument (the lazy init).
      {
        code: `
        function ExpandButton() {
          const [s] = useReducer(reducer, null, () => appNavSink.peek());
          return s;
        }
      `,
        errors: [{ messageId: "renderPhasePeek" }],
      },
      // Inline array-method callback in a component body.
      {
        code: `
        function TabList({ tabs }) {
          return tabs.map((t) => <Tab key={t.id} nav={appNavSink.peek()} />);
        }
      `,
        errors: [{ messageId: "renderPhasePeek" }],
      },
      // Inside a custom hook body — hooks run during render too.
      {
        code: `
        export function useCanNavigate() {
          return appNavSink.peek() !== null;
        }
      `,
        errors: [{ messageId: "renderPhasePeek" }],
      },
      // Bare identifier call (not a member call) in a component body.
      {
        code: `
        function ExpandButton() {
          const nav = peekAppNavigator();
          return nav;
        }
      `,
        errors: [{ messageId: "renderPhasePeek" }],
      },
      // An IIFE inside a useMemo inside a component — two whitelisted boundaries.
      {
        code: `
        function ExpandButton() {
          const v = useMemo(() => (() => appNavSink.peek())(), []);
          return v;
        }
      `,
        errors: [{ messageId: "renderPhasePeek" }],
      },
    ],
  },
);
