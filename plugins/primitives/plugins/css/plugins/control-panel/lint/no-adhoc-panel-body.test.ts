/**
 * Tests for the `no-adhoc-panel-body` lint rule. Run with `./equin test
 * plugins/primitives/plugins/css/plugins/control-panel`.
 *
 * The rule watches three ways a panel body sections itself by hand: a
 * `DropdownMenuSeparator` used where there is no dropdown menu, a `<Separator>`
 * inside a floating panel surface, and an `h-px` + `bg-border` hairline drawn
 * out of raw utilities. The cases below lock in the edges that decide whether it
 * is signal or noise: a separator inside a real menu (including a SUB-menu) is
 * fine; a separator in a different component from its menu is NOT (the function
 * boundary); a `<Separator>` outside a panel surface is fine; and half a hairline
 * — a bare `h-px` spacer, or a bare `bg-border` fill — is not a hairline.
 *
 * The fourth signal is the two-hosts fork: a `<ControlPanel>` body opened by a
 * generic floating surface instead of `ControlPanelPopover`. Its edges are the
 * NEAREST host (a legal one further up does not vouch for a generic one nested
 * inside it), `DialogContent` staying legal, and a body factored into its own
 * component being nobody's violation — the host is a different line of code.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
// The rule is a FACTORY taking the shared class-token walk (rule files cannot
// import it — they dual-load under jiti). Tests run under Bun, where the
// `@plugins/*` alias resolves, so they construct it with the real toolkit.
import { lintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-adhoc-panel-body";

const rule = buildRule(lintToolkit);

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
  "no-adhoc-panel-body",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // A separator inside the menu it belongs to.
      {
        code: `const el = <DropdownMenuContent><DropdownMenuItem/><DropdownMenuSeparator/></DropdownMenuContent>;`,
      },
      // A sub-menu counts as a menu surface.
      {
        code: `const el = <DropdownMenuSubContent><DropdownMenuSeparator/></DropdownMenuSubContent>;`,
      },
      // Nested several levels deep, through a fragment.
      {
        code: `const el = <DropdownMenuContent><><div><DropdownMenuSeparator/></div></></DropdownMenuContent>;`,
      },
      // THE grouped-menu shape: the separator is emitted from an inline `.map()`
      // callback, which is the same JSX tree as the content around it — not a
      // different component. (This is `operator-picker.tsx`, and treating the
      // callback as a boundary reported every grouped menu in the repo.)
      {
        code: `const el = <DropdownMenuContent>{groups.map((g, i) => (<Fragment key={g.label}>{i > 0 && <DropdownMenuSeparator/>}<DropdownMenuItem/></Fragment>))}</DropdownMenuContent>;`,
      },
      // Same, one function expression deep instead of an arrow.
      {
        code: `const el = <DropdownMenuContent>{groups.map(function (g) { return <DropdownMenuSeparator key={g.id}/>; })}</DropdownMenuContent>;`,
      },
      // `CursorAnchoredMenu` renders its children straight into a
      // `DropdownMenuContent`, so it IS a menu surface despite the name.
      {
        code: `const el = <CursorAnchoredMenu anchor={a} onClose={c}><DropdownMenuItem/><DropdownMenuSeparator/></CursorAnchoredMenu>;`,
      },
      // A non-JSX reference to the component must not trip.
      {
        code: `const x = DropdownMenuSeparator; register(DropdownMenuSeparator);`,
      },
      // `<Separator>` outside a floating panel — a form, a card, a page — is the
      // primitive doing its job.
      { code: `const el = <div><Separator/></div>;` },
      // A separator in a DIFFERENT component from a panel surface: the walk stops
      // at the function boundary, so this is not attributed to the panel.
      {
        code: `function Body(){ return <Separator/>; } function Panel(){ return <PopoverContent><Body/></PopoverContent>; }`,
      },
      // Half a hairline is not a hairline: a bare `h-px` spacer …
      { code: `const el = <div className="h-px w-full" />;` },
      // … and a bare border fill.
      { code: `const el = <div className="bg-border rounded-md" />;` },
      // A `h-pxl`-ish near-miss must not match — the height token is anchored.
      { code: `const el = <div className="h-pxl bg-border" />;` },

      // ── Signal D: which surface hosts the panel body ──────────────────
      // The sanctioned host.
      {
        code: `const el = <ControlPanelPopover trigger={t}><ControlPanel><ControlPanel.Section/></ControlPanel></ControlPanelPopover>;`,
      },
      // A dialog is the documented second home — a bare panel inheriting the
      // dialog's width on purpose.
      {
        code: `const el = <DialogContent><ControlPanel><ControlPanel.Section/></ControlPanel></DialogContent>;`,
      },
      // A panel body factored into its own component sees no host at all, and
      // that is the normal shape — whoever opens `<Body/>` owns the choice.
      {
        code: `function Body(){ return <ControlPanel><ControlPanel.Section/></ControlPanel>; } function Panel(){ return <InlinePopover><Body/></InlinePopover>; }`,
      },
      // The members are not the body: only the root element declares a host.
      {
        code: `const el = <InlinePopover><ControlPanel.Section><ControlPanel.Row>x</ControlPanel.Row></ControlPanel.Section></InlinePopover>;`,
      },
      // No surface anywhere — a panel rendered inline in a page.
      {
        code: `const el = <div><ControlPanel><ControlPanel.Row>x</ControlPanel.Row></ControlPanel></div>;`,
      },
    ],
    invalid: [
      // The borrowed divider, with no menu anywhere.
      {
        code: `const el = <PopoverContent><DropdownMenuSeparator/></PopoverContent>;`,
        errors: [{ messageId: "separatorOutsideMenu" }],
      },
      // Bare, at the top of a JSX return.
      {
        code: `const el = <DropdownMenuSeparator/>;`,
        errors: [{ messageId: "separatorOutsideMenu" }],
      },
      // In a separate component from the menu content — a declaration …
      {
        code: `function Body(){ return <DropdownMenuSeparator/>; } function Menu(){ return <DropdownMenuContent><Body/></DropdownMenuContent>; }`,
        errors: [{ messageId: "separatorOutsideMenu" }],
      },
      // … and an arrow bound to a capitalized name, which is the other way a
      // component is written. (Both are boundaries; an inline callback is not.)
      {
        code: `const Body = () => <DropdownMenuSeparator/>; const Menu = () => <DropdownMenuContent><Body/></DropdownMenuContent>;`,
        errors: [{ messageId: "separatorOutsideMenu" }],
      },
      // The dodge: swap to the generic divider, stay inside the panel.
      {
        code: `const el = <PopoverContent><Separator/></PopoverContent>;`,
        errors: [{ messageId: "separatorInPanel" }],
      },
      {
        code: `const el = <InlinePopover><div><Separator/></div></InlinePopover>;`,
        errors: [{ messageId: "separatorInPanel" }],
      },
      {
        code: `const el = <OverlayPanel><Separator/></OverlayPanel>;`,
        errors: [{ messageId: "separatorInPanel" }],
      },
      {
        code: `const el = <FloatingSurface><Separator/></FloatingSurface>;`,
        errors: [{ messageId: "separatorInPanel" }],
      },
      // The hairline, drawn by hand — as one literal …
      {
        code: `const el = <div className="h-px bg-border" />;`,
        errors: [{ messageId: "handRolledHairline" }],
      },
      // … split across `cn()` arguments …
      {
        code: `const el = <div className={cn("my-2 h-px", "bg-border/50")} />;`,
        errors: [{ messageId: "handRolledHairline" }],
      },
      // … in a template literal, with an interpolation between the two halves
      // (the fixture is itself a template literal with the `$` escaped, so this
      // file contains no string literal carrying a `${…}`) …
      {
        code: `const el = <div className={\`h-px \${x} bg-border\`} />;`,
        errors: [{ messageId: "handRolledHairline" }],
      },
      // … and as a conditional class-map key.
      {
        code: `const el = <div className={clsx({ "h-px bg-border": on })} />;`,
        errors: [{ messageId: "handRolledHairline" }],
      },

      // ── Signal D: the two-hosts fork ──────────────────────────────────
      // The exact shape that silently changed the panel's inset: the body
      // opened by the generic popover wrapper, which defaults to `padding="md"`.
      {
        code: `const el = <InlinePopover trigger={t}><ControlPanel><ControlPanel.Section/></ControlPanel></InlinePopover>;`,
        errors: [{ messageId: "panelInGenericSurface" }],
      },
      // The raw ui-kit surface, one level below it.
      {
        code: `const el = <PopoverContent><ControlPanel/></PopoverContent>;`,
        errors: [{ messageId: "panelInGenericSurface" }],
      },
      // A menu surface is a host too — and a menu brings its own item chrome
      // on top of its padding.
      {
        code: `const el = <DropdownMenuContent><ControlPanel/></DropdownMenuContent>;`,
        errors: [{ messageId: "panelInGenericSurface" }],
      },
      // The NEAREST host decides. A legal `ControlPanelPopover` further up does
      // not vouch for a generic surface opened inside it.
      {
        code: `const el = <ControlPanelPopover trigger={t}><InlinePopover trigger={u}><ControlPanel/></InlinePopover></ControlPanelPopover>;`,
        errors: [{ messageId: "panelInGenericSurface" }],
      },
      // Nested through plain markup, and emitted from an inline callback — the
      // same walk-through-callbacks rule the separator signals use.
      {
        code: `const el = <PopoverContent>{items.map((i) => (<div key={i.id}><ControlPanel/></div>))}</PopoverContent>;`,
        errors: [{ messageId: "panelInGenericSurface" }],
      },
    ],
  },
);
