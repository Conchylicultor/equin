/**
 * Tests for the `no-grow-in-effect` lint rule: a live read's `loadMore()`
 * called from an effect — the auto-grow loop.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-grow-in-effect";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  },
});

const grow = { messageId: "growInEffect" as const };

// `RuleTester.run` drives the test harness itself, so it runs at top level.
ruleTester.run(
  "no-grow-in-effect",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // A user's click.
      { code: `const props = { onClick: result.loadMore };` },
      { code: `const onClick = () => result.loadMore();` },
      // A sentinel-driven pager outside an effect.
      {
        code: `useInfiniteScroll({ fetchNextPage: () => settled?.loadMore() });`,
      },
      // An effect that does something else.
      { code: `useEffect(() => { report(rows); }, [rows]);` },
      // A binding that CALLS loadMore is not a handle to it.
      {
        code: `const grown = result.loadMore(); useEffect(() => { use(grown); }, [grown]);`,
      },
      // A handle not traced through a hook's return.
      {
        code: `const grow = useGrow(); useEffect(() => { grow(); }, [grow]);`,
      },
      // An unrelated call named like an effect argument.
      { code: `useMemo(() => result.loadMore, [result]);` },
      // A function of the file's own that is merely named `loadMore`.
      {
        code: `function loadMore() { fetchMore(); } useEffect(() => { loadMore(); }, []);`,
      },
      {
        code: `const loadMore = () => fetchMore(); useEffect(() => { loadMore(); }, []);`,
      },
    ],
    invalid: [
      // The task-track loop this rule exists for.
      {
        code: `
          const grow = result.status === "ready" && result.canGrow && !result.growing
            ? result.loadMore
            : null;
          useEffect(() => { grow?.(); }, [grow]);`,
        errors: [grow],
      },
      { code: `useEffect(() => { result.loadMore(); });`, errors: [grow] },
      { code: `useLayoutEffect(() => { r?.loadMore(); });`, errors: [grow] },
      { code: `React.useEffect(() => { r.loadMore(); });`, errors: [grow] },
      {
        code: `useEffect(function () { if (full) r["loadMore"](); });`,
        errors: [grow],
      },
      {
        code: `const { loadMore } = result; useEffect(() => { loadMore(); });`,
        errors: [grow],
      },
      {
        code: `const { loadMore: more } = result; useEffect(() => { more(); });`,
        errors: [grow],
      },
      {
        code: `const more = (result.loadMore as () => void); useEffect(() => { more(); });`,
        errors: [grow],
      },
      // Nested closures inside the effect too.
      {
        code: `useEffect(() => { const id = setTimeout(() => r.loadMore(), 0); return () => clearTimeout(id); });`,
        errors: [grow],
      },
      // The effect's callback IS the grow.
      { code: `useEffect(result.loadMore, [result]);`, errors: [grow] },
      { code: `useInsertionEffect(() => { r.loadMore(); });`, errors: [grow] },
      // Deliberately strict: a handler the effect registers is a hand-built
      // pager — data-view / useInfiniteScroll own that sentinel.
      {
        code: `useEffect(() => { const io = new IntersectionObserver(() => r.loadMore()); io.observe(el); return () => io.disconnect(); }, [r]);`,
        errors: [grow],
      },
      {
        code: `useEffect(() => { const on = () => r.loadMore(); el.addEventListener("scroll", on); return () => el.removeEventListener("scroll", on); }, [r]);`,
        errors: [grow],
      },
      // A `loadMore` destructured from a parameter is a handle.
      {
        code: `function List({ loadMore }) { useEffect(() => { loadMore(); }); }`,
        errors: [grow],
      },
    ],
  },
);
