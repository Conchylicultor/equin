/**
 * Tests for the `no-orphan-composite-role` lint rule. Run with `bun test`
 * from the repo root (or this file's directory).
 *
 * The rule flags a composite container role (listbox, tablist, tree, treegrid,
 * grid, menu, menubar, radiogroup) declared in a file that carries none of the
 * child roles that container requires. It must fire on the page editor's bug
 * shape (a `listbox` with no `option` anywhere) but never on:
 *   - a container paired in-file with its children, in either source order,
 *   - a container whose children carry one of several accepted child roles,
 *   - a non-composite role, or a role on a child (`option` on its own),
 *   - a computed `role={x}` — not analyzable, so not guessed at.
 */

import rule from "./no-orphan-composite-role";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-orphan-composite-role", rule, {
  valid: [
    // The prescribed shape: container and children in one file (file-tabs.tsx).
    {
      code: `
          const el = (
            <Stack role="tablist">
              {tabs.map((t) => <button key={t.id} role="tab" aria-selected={t.active}>{t.label}</button>)}
            </Stack>
          );
        `,
      },
      // Children authored ABOVE the container — the verdict is per FILE, not
      // per source position.
      {
        code: `
          const item = <div role="option">A</div>;
          const list = <div role="listbox">{item}</div>;
        `,
      },
      // A menu satisfied by any ONE of its three accepted child roles.
      {
        code: `
          const el = (
            <div role="menu">
              <div role="menuitemcheckbox" aria-checked={on} />
            </div>
          );
        `,
      },
      // radiogroup + radio (toggle-chip's SegmentedControl).
      {
        code: `
          const el = (
            <div role="radiogroup">
              <button role="radio" aria-checked={sel} />
            </div>
          );
        `,
      },
      // grid + row.
      {
        code: `<div role="grid"><div role="row"><span role="gridcell" /></div></div>;`,
      },
      // tree + treeitem.
      {
        code: `<ul role="tree"><li role="treeitem">A</li></ul>;`,
      },
      // A child role on its own carries no contract — only containers do.
      {
        code: `<div role="option" aria-selected={sel}>A</div>;`,
      },
      // Non-composite roles are out of scope entirely.
      {
        code: `<div role="group" aria-label="Page blocks"><Row /></div>;`,
      },
      // Computed role — not analyzable, so never guessed at.
      {
        code: `<div role={containerRole}><div role={itemRole} /></div>;`,
      },
      // The braces-around-a-literal form is read like the bare literal.
      {
        code: `<div role={"listbox"}><div role={"option"} /></div>;`,
      },
      // A fallback role list contributes every token, so `option` still counts.
      {
        code: `<div role="listbox"><div role="doc-item option" /></div>;`,
      },
    ],
    invalid: [
      // The page editor's bug, verbatim in shape: a listbox over rows that are
      // not options.
      {
        code: `
          const el = (
            <Overlay role="listbox" aria-multiselectable aria-label="Page blocks">
              {rows.map((r) => <BlockRow key={r.id} block={r} />)}
            </Overlay>
          );
        `,
        errors: [
          {
            messageId: "orphanCompositeRole",
            data: { role: "listbox", children: 'role="option"' },
          },
        ],
      },
      // A tablist whose tabs are somewhere else entirely.
      {
        code: `<div role="tablist">{children}</div>;`,
        errors: [{ messageId: "orphanCompositeRole" }],
      },
      // grid without rows — a CSS grid wearing a widget's name.
      {
        code: `<Grid cols={7} role="grid">{days.map((d) => <Button key={d} />)}</Grid>;`,
        errors: [{ messageId: "orphanCompositeRole" }],
      },
      // `gridcell` without the intervening `row` does not satisfy `grid`.
      {
        code: `<div role="grid"><span role="gridcell" /></div>;`,
        errors: [{ messageId: "orphanCompositeRole" }],
      },
      // menubar wants a menuitem, not a `tab`.
      {
        code: `<div role="menubar"><div role="tab" /></div>;`,
        errors: [{ messageId: "orphanCompositeRole" }],
      },
      // Two orphan containers in one file → one report each.
      {
        code: `
          const a = <div role="tree">{nodes}</div>;
          const b = <div role="radiogroup">{opts}</div>;
        `,
        errors: [
          { messageId: "orphanCompositeRole" },
          { messageId: "orphanCompositeRole" },
        ],
      },
    ],
  },
);
