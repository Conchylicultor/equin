/**
 * Tests for the `no-dropped-gesture` lint rule: `PLAIN_GESTURE` in a clickable
 * `on*` handler is a link forced through a callback. The invalid cases are the
 * four buttons that shipped that way (Open theme editor, Open as page, New
 * app, the analytics overview rows) and the Configure gear before them.
 */

import rule from "./no-dropped-gesture";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

const dropped = { messageId: "dropped" } as const;

const CORE = `import { PLAIN_GESTURE, runActivation } from "@plugins/primitives/plugins/link-gesture/core";\n`;

ruleTester.run("no-dropped-gesture", rule, {
  valid: [
    // The data form — the fix.
    { code: CORE + `<ControlPanel.Row activation={editor} />;` },
    // No pointer gesture to read: a key handler, after a mutation, a picked value.
    {
      code:
        CORE +
        `<div onKeyDown={() => runActivation(target, PLAIN_GESTURE)} />;`,
    },
    {
      code:
        CORE + `useCreate({ onCreated: (id) => to(id).open(PLAIN_GESTURE) });`,
    },
    {
      code:
        CORE +
        `deleteIt({ onDeleted: () => { clear(); close(PLAIN_GESTURE); } });`,
    },
    {
      code:
        CORE +
        `const onTaskCreated = useCallback((id) => target(id).open(PLAIN_GESTURE), []);`,
    },
    {
      code:
        CORE + `<Select onValueChange={(v) => to(v).open(PLAIN_GESTURE)} />;`,
    },
    // Not inside a handler at all (a hook's own logic, a shortcut table).
    {
      code:
        CORE +
        `const shortcuts = [{ key: "u", handler: () => runActivation(up, PLAIN_GESTURE) }];`,
    },
    { code: CORE + `function select(id) { onSelect(id, PLAIN_GESTURE); }` },
    // A same-named local, not link-gesture's.
    {
      code: `const PLAIN_GESTURE = { keepOthers: false };\n<Row onSelect={() => t.open(PLAIN_GESTURE)} />;`,
    },
  ],
  invalid: [
    {
      code:
        CORE +
        `<ControlPanel.Row onSelect={() => runActivation(editor, PLAIN_GESTURE)} />;`,
      errors: [dropped],
    },
    {
      code:
        CORE +
        `const creators = [{ id: "new", label: "New app", onSelect: () => newApp.open(PLAIN_GESTURE) }];`,
      errors: [dropped],
    },
    {
      code:
        CORE + `<RankedList onFilterRow={() => link.open(PLAIN_GESTURE)} />;`,
      errors: [dropped],
    },
    {
      code:
        CORE +
        `const action = { icon, label, onAction: () => runActivation(link, PLAIN_GESTURE) };`,
      errors: [dropped],
    },
    // Behind a conditional, in a block body.
    {
      code:
        CORE +
        `<Dialog onBack={back === null ? undefined : () => { back(PLAIN_GESTURE); }} />;`,
      errors: [dropped],
    },
    // A named useCallback handler.
    {
      code:
        CORE +
        `const onNavigate = useCallback((id) => target(id).open(PLAIN_GESTURE), []);`,
      errors: [dropped],
    },
  ],
});
