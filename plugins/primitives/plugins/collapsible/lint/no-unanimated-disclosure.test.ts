/**
 * Tests for the `no-unanimated-disclosure` lint rule.
 *
 * The `invalid` cases are the shapes the migration removed from the repo (a
 * content gate on `useCollapsible`'s `open`, on `useExpandAll`'s set, on what a
 * hand-rolled `aria-expanded` trigger reports). The `valid` cases are the real
 * shapes that must never trip it: the folded spellings, a trigger's own chrome,
 * and popup triggers (`aria-haspopup`), whose content is not a fold.
 */

import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-unanimated-disclosure";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

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

const error = [{ messageId: "unanimatedDisclosure" as const }];

// `RuleTester.run` registers bun:test cases, so it runs at module top level —
// never wrapped in a `test()` callback.
ruleTester.run(
  "no-unanimated-disclosure",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // The default spelling: the content bag on a FoldMotion.
      {
        code: `function A() {
          const { open, triggerProps, contentProps } = useCollapsible();
          return <div><button {...triggerProps}>{open ? "Hide" : "Show"}</button>
            <FoldMotion {...contentProps}><Body /></FoldMotion></div>;
        }`,
      },
      // The trigger's own chrome may swap on `open` — an icon, a label.
      {
        code: `function A() {
          const { open, triggerProps, contentProps } = useCollapsible();
          return <button {...triggerProps}>{open ? <Up /> : <Down />}</button>;
        }`,
      },
      {
        code: `function A({ open, onToggle }) {
          return <button aria-expanded={open} onClick={onToggle}>
            {open && <Badge>open</Badge>}
          </button>;
        }`,
      },
      // A popup trigger: the menu is a portal, not a fold.
      {
        code: `function A() {
          const [open, setOpen] = useState(false);
          return <><button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} />
            {open && <Menu />}</>;
        }`,
      },
      // A boolean no trigger reports is not a disclosure (an edit mode).
      {
        code: `function A() {
          const [editing, setEditing] = useState(false);
          return editing ? <Input /> : <Label />;
        }`,
      },
      // A gate on something else in a component that also has a disclosure.
      {
        code: `function A({ rows }) {
          const { contentProps, triggerProps } = useCollapsible();
          return <><button {...triggerProps} />{rows.length > 0 && <List rows={rows} />}
            <FoldMotion {...contentProps} /></>;
        }`,
      },
      // A non-JSX value gated on open.
      {
        code: `function A() {
          const { open } = useCollapsible();
          const label = open && "expanded";
          return <span>{label}</span>;
        }`,
      },
    ],
    invalid: [
      // useCollapsible's open, destructured.
      {
        code: `function A() {
          const { open, triggerProps } = useCollapsible();
          return <div><button {...triggerProps} />{open && <Body />}</div>;
        }`,
        errors: error,
      },
      // …renamed, and in a chain.
      {
        code: `function A({ items }) {
          const { open: expanded, toggle } = useCollapsible();
          return <>{expanded && items.length > 0 && items.map((i) => <Row key={i} />)}</>;
        }`,
        errors: error,
      },
      // …read off the result, as a swap.
      {
        code: `function A() {
          const c = useCollapsible();
          return c.open ? <Full /> : <Summary />;
        }`,
        errors: error,
      },
      // useCollapsibleContext.
      {
        code: `function A() {
          const ctx = useCollapsibleContext();
          return <>{ctx?.open && <Body />}</>;
        }`,
        errors: error,
      },
      // useExpandAll's set.
      {
        code: `function A({ paths }) {
          const { expanded, toggle } = useExpandAll(paths);
          return paths.map((p) => <div key={p}>{expanded.has(p) ? <Diff /> : null}</div>);
        }`,
        errors: error,
      },
      // A hand-rolled trigger: whatever aria-expanded reports is the state.
      {
        code: `function A() {
          const [showQuoted, setShowQuoted] = useState(false);
          return <><button aria-expanded={showQuoted} onClick={() => setShowQuoted((v) => !v)} />
            {showQuoted && <Quoted />}</>;
        }`,
        errors: error,
      },
      // …a gated aria-expanded reports its value, not the gate.
      {
        code: `function A({ hasDetail }) {
          const [open, setOpen] = useState(true);
          return <><button aria-expanded={hasDetail ? open : undefined} />
            {hasDetail && open && <Detail />}</>;
        }`,
        errors: error,
      },
      // …a prop, and a negated gate.
      {
        code: `function Header({ collapsed, onToggle }) {
          return <><button aria-expanded={!collapsed} onClick={onToggle} />
            {!collapsed && <Children />}</>;
        }`,
        errors: error,
      },
      // …a member read, within the same component.
      {
        code: `function A({ row }) {
          return <><button aria-expanded={row.expanded} />{row.expanded && <Detail />}</>;
        }`,
        errors: error,
      },
      // A CollapsibleChevron reports the state as surely as aria-expanded.
      {
        code: `function A({ node }) {
          const [legendOpen, setLegendOpen] = useState(false);
          return <><button onClick={() => setLegendOpen((o) => !o)}>
              <CollapsibleChevron open={legendOpen} /></button>
            {legendOpen && <Legend />}</>;
        }`,
        errors: error,
      },
      // The browser's own disclosure.
      {
        code: `const el = <details><summary>3 scopes</summary><ul /></details>;`,
        errors: [{ messageId: "nativeDetails" as const }],
      },
    ],
  },
);
