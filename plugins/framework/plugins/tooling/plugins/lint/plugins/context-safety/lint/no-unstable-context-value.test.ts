/**
 * Tests for the `no-unstable-context-value` lint rule. Run with `bun test` from
 * the repo root (or this file's directory).
 *
 * The rule bans inline-constructed reference values (object/array/function/new)
 * on a context Provider's `value` prop, because each render produces a fresh
 * identity that re-renders every useContext consumer. It must fire on every
 * provider form (`Foo.Provider`, bare `<SomeContext>`, `<SomeProvider>`) but
 * never on stable references (memoized vars, identifiers) or primitives
 * (booleans, strings, template literals), nor on non-provider elements.
 */

import rule from "./no-unstable-context-value";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-unstable-context-value", rule, {
  valid: [
    // Stable references — the correct pattern.
    { code: `<Ctx.Provider value={memoized}>{x}</Ctx.Provider>` },
    { code: `<ThemeContext value={memoized}>{x}</ThemeContext>` },
    { code: `<MyProvider value={ctxValue}>{x}</MyProvider>` },
    // Primitives are compared by value, not identity — fine.
    { code: `<SingleLineContext value={true}>{x}</SingleLineContext>` },
    { code: `<ModeContext value={mode}>{x}</ModeContext>` },
    { code: `<NameContext value={\`\${a}\`}>{x}</NameContext>` },
    // Call expressions (e.g. useMemo / store hooks) are not flagged.
    { code: `<Ctx.Provider value={useStore()}>{x}</Ctx.Provider>` },
    {
      code: `function C() { const v = useStore(); return <Ctx.Provider value={v}>{x}</Ctx.Provider>; }`,
    },
    // Indirect via a render-scoped useMemo result — stable.
    {
      code: `function C() { const v = useMemo(() => ({ a }), [a]); return <Ctx.Provider value={v}>{x}</Ctx.Provider>; }`,
    },
    // Indirect via a MODULE-LEVEL constant — created once, stable.
    {
      code: `const SHARED = { a: 1 }; function C() { return <Ctx.Provider value={SHARED}>{x}</Ctx.Provider>; }`,
    },
    // Indirect via a prop / non-constructed binding.
    {
      code: `function C({ v }) { return <Ctx.Provider value={v}>{x}</Ctx.Provider>; }`,
    },
    // Not a provider element — out of scope.
    { code: `<Select value={{ a: 1 }}>{x}</Select>` },
    { code: `<input value={{}.toString()} />` },
    // `value` on a provider but not an expression container.
    { code: `<Foo.Provider value="x">{y}</Foo.Provider>` },
  ],
  invalid: [
    {
      code: `<Ctx.Provider value={{ a, b }}>{x}</Ctx.Provider>`,
      errors: [{ messageId: "unstableContextValue" }],
    },
    {
      code: `<ThemeContext value={{ theme }}>{x}</ThemeContext>`,
      errors: [{ messageId: "unstableContextValue" }],
    },
    {
      code: `<StoreProvider value={{ state, dispatch }}>{x}</StoreProvider>`,
      errors: [{ messageId: "unstableContextValue" }],
    },
    {
      code: `<Ctx.Provider value={[1, 2, 3]}>{x}</Ctx.Provider>`,
      errors: [{ messageId: "unstableContextValue" }],
    },
    {
      code: `<Ctx.Provider value={() => {}}>{x}</Ctx.Provider>`,
      errors: [{ messageId: "unstableContextValue" }],
    },
    {
      code: `<Ctx.Provider value={function () {}}>{x}</Ctx.Provider>`,
      errors: [{ messageId: "unstableContextValue" }],
    },
    {
      code: `<Ctx.Provider value={new Map()}>{x}</Ctx.Provider>`,
      errors: [{ messageId: "unstableContextValue" }],
    },
    // Indirect: render-scoped const initialized to a constructed value.
    {
      code: `function C() { const v = { a, b }; return <Ctx.Provider value={v}>{x}</Ctx.Provider>; }`,
      errors: [{ messageId: "unstableContextValue" }],
    },
    {
      code: `function C() { const v = [1, 2]; return <ThemeContext value={v}>{x}</ThemeContext>; }`,
      errors: [{ messageId: "unstableContextValue" }],
    },
  ],
});
