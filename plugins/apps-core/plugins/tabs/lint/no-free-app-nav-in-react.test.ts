/**
 * Tests for the `no-free-app-nav-in-react` lint rule.
 *
 * The rule bans a reference to the tabs barrel's free `navigate` / `appLink` /
 * `appLinkProps` inside a component or hook — but must NOT fire on the hook
 * forms, on callers outside React, or on a same-named function that is not
 * the tabs barrel's.
 */

import { describe, it } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-free-app-nav-in-react";

// Hand RuleTester bun's own describe/it, or it registers nothing under
// `./equin test`.
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

const free = { messageId: "free" } as const;

const TABS = `import { navigate, appLink, appLinkProps, useNavigate, useAppLink, useAppLinkProps } from "@plugins/apps-core/plugins/tabs/web";\n`;

// `RuleTester.run` drives the test harness itself, so it must run at module
// top level — never wrapped in a `test()` callback.
ruleTester.run(
  "no-free-app-nav-in-react",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // The hook forms — the fix.
      {
        code:
          TABS +
          `function Chip({ url }) { const p = useAppLinkProps(); return <Row {...p(url)} />; }`,
      },
      {
        code:
          TABS +
          `function useOpen() { const go = useNavigate(); return () => go("/x"); }`,
      },
      {
        code:
          TABS +
          `const Chip = () => { const link = useAppLink(); return <Row activation={link("/x")} />; };`,
      },
      // Outside React: a module-level helper, a store, a command.
      {
        code: TABS + `export function openReport(id) { navigate("/r/" + id); }`,
      },
      { code: TABS + `const goHome = () => navigate("/");` },
      {
        code:
          TABS + `export const commands = { run: () => appLink("/x").open() };`,
      },
      { code: TABS + `navigate("/boot");` },
      // A namespace import's hook form, and its free form outside React.
      {
        code: `import * as tabs from "@plugins/apps-core/plugins/tabs/web";\nfunction Chip() { const go = tabs.useNavigate(); return <Row onSelect={() => go("/x")} />; }\nexport const open = () => tabs.navigate("/x");`,
      },
      // A `navigate` that is not the tabs barrel's.
      {
        code: `import { navigate } from "./router";\nfunction Chip() { return <Row onClick={() => navigate("/x")} />; }`,
      },
      {
        code: `function Chip({ navigate }) { return <Row onClick={() => navigate("/x")} />; }`,
      },
    ],
    invalid: [
      // JSX at module level — a table column's cell renders inside React.
      {
        code:
          TABS +
          `const columns = { trace: { cell: (r) => <Chip activation={appLink(r.url)} /> } };`,
        errors: [free],
      },
      // A namespace import is the same reference.
      {
        code: `import * as tabs from "@plugins/apps-core/plugins/tabs/web";\nfunction Chip() { return <Row onSelect={() => tabs.navigate("/x")} />; }`,
        errors: [free],
      },
      // In a component's body.
      {
        code:
          TABS +
          `function Chip({ url }) { return <Row {...appLinkProps(url)} />; }`,
        errors: [free],
      },
      // In a callback inside a component.
      {
        code:
          TABS +
          `function Chip() { return <Row onSelect={() => navigate("/x")} />; }`,
        errors: [free],
      },
      // An arrow component, a function passed as a value.
      {
        code: TABS + `const Chip = () => <Row onSelect={navigate} />;`,
        errors: [free],
      },
      // A wrapped component.
      {
        code:
          TABS +
          `const Chip = memo(function () { return <Row activation={appLink("/x")} />; });`,
        errors: [free],
      },
      {
        code:
          TABS + `const Chip = memo(() => <Row activation={appLink("/x")} />);`,
        errors: [free],
      },
      // In a hook.
      {
        code:
          TABS +
          `export function useConfigLink() { return useCallback(() => appLink("/c").open(), []); }`,
        errors: [free],
      },
      // Renamed on import.
      {
        code: `import { navigate as go } from "@plugins/apps-core/plugins/tabs/web";\nfunction Chip() { return <Row onSelect={() => go("/x")} />; }`,
        errors: [free],
      },
      // Each reference is reported.
      {
        code:
          TABS +
          `function Chip() { navigate("/a"); return <Row {...appLinkProps("/b")} />; }`,
        errors: [free, free],
      },
    ],
  },
);
