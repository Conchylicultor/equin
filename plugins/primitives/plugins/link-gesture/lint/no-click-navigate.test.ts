/**
 * Tests for the `no-click-navigate` lint rule.
 *
 * The rule bans a click-style callback whose only job is to navigate, and an
 * activation that is such a callback (or a resolver returning one) — but must
 * NOT fire on the link / data forms, on handlers doing other work, on opens
 * outside an activation (`onSelect`, `onCreated`), or on a `navigate` that is
 * not the tabs barrel's.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-click-navigate";

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

const handler = { messageId: "handler" } as const;
const activation = { messageId: "activation" } as const;
const resolver = { messageId: "resolver" } as const;

const TABS = `import { navigate, appLink } from "@plugins/apps-core/plugins/tabs/web";\n`;

// `RuleTester.run` drives the test harness itself (it calls the ambient
// describe/it that bun:test provides), so it must run at module top level —
// never wrapped in a `test()` callback.
ruleTester.run(
  "no-click-navigate",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // The link / data forms — the fix.
      { code: `<Button {...openPane.link(p, { id }, { mode: "push" })} />;` },
      { code: `<LinkChip activation={openPane.to(p, { id })} />;` },
      { code: TABS + `<Row activation={appLink(url)} />;` },
      {
        code: `<DataView rowActivation={(r) => openPane.to(p, { id: r.id })} />;`,
      },
      {
        code: `
          const openPane = useOpenPane();
          <DataView rowActivation={(r) => openPane.to(p, { id: r.id })} />;
        `,
      },
      // Handlers doing other work besides.
      {
        code: `
          <Button
            onClick={() => {
              if (inline) toggle();
              else openPane(p, { id }, { mode: "push" });
            }}
          />;
        `,
      },
      {
        code: `<Button onClick={() => { track("x"); openPane(p, {}); }} />;`,
      },
      // Opens outside an activation.
      {
        code: `<List onSelect={(id) => openPane(p, { id }, { mode: "push" })} />;`,
      },
      {
        code: `const item = { onSelect: () => openPane(p, {}, { mode: "root" }) };`,
      },
      { code: `<Form onCreated={(id) => openPane(p, { id })} />;` },
      { code: TABS + `<Form onSuccess={() => navigate(url)} />;` },
      // A `navigate` that is not the tabs barrel's (the browser app's own).
      { code: `<Button onClick={() => navigate(url)} />;` },
      {
        code:
          `import { navigate } from "../internal/history";\n` +
          `<Button onClick={() => navigate(url)} />;`,
      },
      // An explicit new in-app tab is a menu entry, not a link gesture.
      {
        code:
          TABS +
          `<MenuItem onClick={() => navigate(url, { newTab: true })} />;`,
      },
      // A `useOpen*` hook that is not navigation (a host file's default app).
      {
        code: `
          const openHostFile = useOpenHostFile();
          <Button onClick={() => openHostFile(path)} />;
        `,
      },
      // A callee that is not an opener.
      { code: `<Button onClick={() => store.openPaneImpl(p, {})} />;` },
      { code: `<Button onClick={() => dialog.open(config)} />;` },
      // A handler from props / another module is not inspected.
      { code: `<Button onClick={open} />;` },
      { code: `function C({ onOpen }) { return <Row onClick={onOpen} />; }` },
      // An activation that does not navigate.
      { code: `<DataView onRowActivate={(r) => toggle(r.id)} />;` },
      {
        code: `<DataView rowActivation={(r) => (r.ok ? () => grant(r) : undefined)} />;`,
      },
      { code: `<LinkChip activation={() => {}} />;` },
      // Destructuring is not an object literal.
      { code: `const { onClick = () => openPane(p, {}) } = props;` },
    ],
    invalid: [
      {
        code: `<Button onClick={() => openPane(p, { id }, { mode: "push" })} />;`,
        errors: [handler],
      },
      {
        code: `<Button onClick={() => { openPane(p, {}, { mode: "root" }); }} />;`,
        errors: [handler],
      },
      {
        code: `<Button onClick={function () { return openPane(p, {}, { mode: "root" }); }} />;`,
        errors: [handler],
      },
      {
        code: `<Button onClick={() => void openPane(p, {})} />;`,
        errors: [handler],
      },
      // Isolation before the open is still only an open.
      {
        code: `
          <Button
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              openPane(p, { id }, { mode: "push" });
            }}
          />;
        `,
        errors: [handler],
      },
      // A member-call opener.
      {
        code: `<Button onClick={() => ctx.openPane(p, {}, { mode: "push" })} />;`,
        errors: [handler],
      },
      // The tabs barrel's navigate.
      {
        code: TABS + `<Button onClick={() => navigate(url)} />;`,
        errors: [handler],
      },
      {
        code:
          TABS + `<Button onClick={() => navigate(url, { newTab: false })} />;`,
        errors: [handler],
      },
      // Bindings from opener hooks.
      {
        code: `
          const openPane = useOpenPane();
          <Gear onClick={() => openPane(p, {})} />;
        `,
        errors: [handler],
      },
      {
        code: `
          const opener = useConversationOpener();
          <Row onClick={() => opener.toggleNow(id)} />;
        `,
        errors: [handler],
      },
      // A LinkTarget run by hand.
      { code: `<Row onClick={() => target.open()} />;`, errors: [handler] },
      // Other handler names.
      {
        code: `<Graph onNodeClick={(id) => openPane(p, { id })} />;`,
        errors: [handler],
      },
      {
        code: `<Tree onOpenFile={(path) => openPane(p, { path })} />;`,
        errors: [handler],
      },
      {
        code: `<DataView onRowActivate={(r) => openPane(p, { id: r.id }, { mode: "push" })} />;`,
        errors: [handler],
      },
      // Object-property form (a contribution's data).
      {
        code: `const entry = { id: "x", onClick: () => openPane(p, {}, { mode: "root" }) };`,
        errors: [handler],
      },
      {
        code: `const entry = { "onNavigate": () => openPane(p, {}, { mode: "root" }) };`,
        errors: [handler],
      },
      // Same-file named handlers.
      {
        code: `
          const go = () => openPane(p, {});
          <Button onClick={go} />;
        `,
        errors: [handler],
      },
      {
        code: `
          function go() { openPane(p, {}); }
          <Button onClick={go} />;
        `,
        errors: [handler],
      },
      {
        code: `
          const go = useCallback(() => openPane(p, {}), []);
          <Button onClick={go} />;
        `,
        errors: [handler],
      },
      // A plain-function activation that only navigates.
      {
        code: `<LinkChip activation={() => openPane(p, { id })} />;`,
        errors: [activation],
      },
      // Resolvers handing back a navigation-only action.
      {
        code: `<DataView rowActivation={(r) => () => openPane(p, { id: r.id }, { mode: "push" })} />;`,
        errors: [resolver],
      },
      {
        code:
          TABS + `<Commits commitActivation={(c) => () => navigate(c.url)} />;`,
        errors: [resolver],
      },
      {
        code: `const view = { nodeActivation: (id) => () => openPane(p, { id }) };`,
        errors: [resolver],
      },
    ],
  },
);
