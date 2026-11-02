/**
 * Tests for the `no-adhoc-row-list` lint rule. Run with `bun test` from the repo
 * root (or this file's directory).
 *
 * The rule fires on a `.map(cb)` whose callback RETURNS a bare `<Row>` — the
 * hand-rolled-data-list shape DataView exists to close. Detection is name-based
 * (no import/type resolution) and deliberately favors false negatives: a
 * wrapper/fragment CONTAINING a Row, a `SectionHeaderRow`, a Row returned by a
 * nested helper, and a `.map` with a non-callback first arg are all left alone.
 */

import rule from "./no-adhoc-row-list";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-adhoc-row-list", rule, {
  valid: [
    // map returning a plain intrinsic — not a Row.
    `const a = items.map((i) => <div key={i.id}>{i.name}</div>);`,
    // map returning another component — only the bare `Row` identifier trips.
    `const a = items.map((i) => <Item key={i.id} />);`,
    // A fragment WRAPPING a Row — deliberate false negative (grouped/bespoke
    // compositions resolve to the fragment, not the Row).
    `const a = items.map((i) => <><Row key={i.id} /></>);`,
    // A wrapper element CONTAINING a Row — likewise not flagged.
    `const a = items.map((i) => <div><Row key={i.id} /></div>);`,
    // `Row` rendered outside any map is fine (a single row).
    `const a = <Row />;`,
    // A nested inner function returns Row, but the map callback itself returns
    // something else — the inner return is not the map's return.
    `const a = items.map((i) => { const make = () => <Row />; return <Item render={make} />; });`,
    // `.map` with a non-callback first arg (a bare value) — no callback to scan.
    `const a = items.map(fn);`,
    // `SectionHeaderRow` is not a data row.
    `const a = items.map((i) => <SectionHeaderRow key={i.id} />);`,
  ],
  invalid: [
    // Arrow expression body returning a bare Row.
    {
      code: `const a = items.map((i) => <Row key={i.id} />);`,
      errors: [{ messageId: "adhocRowList" }],
    },
    // Parenthesized arrow body — parens carry no AST node; still a bare Row.
    {
      code: `const a = items.map((i) => (<Row key={i.id} />));`,
      errors: [{ messageId: "adhocRowList" }],
    },
    // Block body with an explicit `return <Row/>`.
    {
      code: `const a = items.map((i) => { return <Row key={i.id} />; });`,
      errors: [{ messageId: "adhocRowList" }],
    },
    // Conditional expression body — the truthy branch resolves to a Row.
    {
      code: `const a = items.map((i) => (i.ok ? <Row key={i.id} /> : null));`,
      errors: [{ messageId: "adhocRowList" }],
    },
  ],
});
