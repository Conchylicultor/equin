/**
 * Tests for the `no-provider-trigger-render` lint rule. Run with `bun test`
 * from the repo root (or this file's directory).
 *
 * The rule flags ANY base-ui `render` prop (or a known render-forwarding
 * wrapper like `InlinePopover`'s `trigger`) whose ROOT JSX element is a
 * `*Provider` — a context provider renders no DOM node, so everything the host
 * merges onto that root is silently dropped.
 *
 * It must fire on a provider root wherever `render` appears — a `*Trigger`, a
 * `*Popup` (the `OverlayPanel` composition), the `Menu.Trigger` member form, the
 * InlinePopover wrapper — but never on:
 *   - a DOM-rooted render target (IconButton, raw <button>, Button, OverlayPanel),
 *   - a provider nested DEEPER than the root (cloneElement merges only onto the root),
 *   - a non-`render` prop.
 */

import rule from "./no-provider-trigger-render";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-provider-trigger-render", rule, {
  valid: [
    // DOM-rooted IconButton render target — the prescribed fix.
    {
      code: `const x = <DropdownMenuTrigger render={<IconButton icon={X} label="Add" />} />;`,
    },
    // Provider hoisted as ANCESTOR (not the render root) — harmless.
    {
      code: `
          const x = (
            <ControlSizeProvider>
              <DropdownMenuTrigger render={<IconButton icon={X} label="Add" />} />
            </ControlSizeProvider>
          );
        `,
      },
      // Plain Button render target.
      {
        code: `const x = <PopoverTrigger render={<Button>Open</Button>} />;`,
      },
      // Provider nested DEEPER than the render root — base-ui merges only onto
      // the root, so this is harmless.
      {
        code: `const x = <DropdownMenuTrigger render={<button><ControlSizeProvider>x</ControlSizeProvider></button>} />;`,
      },
      // A DOM-rooted popup panel — the OverlayPanel composition, the shape the
      // widened rule exists to protect.
      {
        code: `const x = <PopoverPrimitive.Popup {...props} render={<OverlayPanel width="sm">{children}</OverlayPanel>} />;`,
      },
      // A provider passed on some OTHER prop is not a render slot.
      {
        code: `const x = <SomeView header={<ControlSizeProvider>x</ControlSizeProvider>} />;`,
      },
      // A hoisted trigger whose root IS a DOM element, with the provider inside.
      {
        code: `
          const trigger = <button><SingleLineProvider>x</SingleLineProvider></button>;
          const x = <InlinePopover trigger={trigger} />;
        `,
      },
      // A hoisted identifier we cannot resolve (a parameter) is not flagged —
      // the rule follows a declaration, it does not guess.
      {
        code: `function View({ trigger }) { return <PopoverTrigger render={trigger} />; }`,
      },
    ],
    invalid: [
      // The canonical bug: ControlSizeProvider wrapping IconButton.
      {
        code: `const x = <DropdownMenuTrigger render={<ControlSizeProvider><IconButton /></ControlSizeProvider>} />;`,
        errors: [{ messageId: "providerAsTriggerRender" }],
      },
      // Member-expression Trigger (Menu.Trigger) with a provider root.
      {
        code: `const x = <Menu.Trigger render={<SingleLineProvider><button /></SingleLineProvider>} />;`,
        errors: [{ messageId: "providerAsTriggerRender" }],
      },
      // The InlinePopover render-forwarding wrapper.
      {
        code: `const x = <InlinePopover trigger={<ControlSizeProvider><Button /></ControlSizeProvider>} />;`,
        errors: [{ messageId: "providerAsTriggerRender" }],
      },
      // The widened case: a POPUP's render root. The panel would render with no
      // positioning ref, no dismiss handlers and no data-open state.
      {
        code: `const x = <PopoverPrimitive.Popup render={<SingleLineProvider><div /></SingleLineProvider>} />;`,
        errors: [{ messageId: "providerAsTriggerRender" }],
      },
      // Any other host's render slot — the seam, not the host, is the hazard.
      {
        code: `const x = <SomeView render={<ControlSizeProvider>x</ControlSizeProvider>} />;`,
        errors: [{ messageId: "providerAsTriggerRender" }],
      },
      // The shape that shipped the live bug: the trigger hoisted into a `const`,
      // rooted at a provider. Reading only the attribute expression missed it.
      {
        code: `
          const trigger = (
            <SingleLineProvider value={true}>
              <Inline as="button">x</Inline>
            </SingleLineProvider>
          );
          const x = <InlinePopover trigger={trigger} tooltip="t" />;
        `,
        errors: [{ messageId: "providerAsTriggerRender" }],
      },
      // Same, through a plain `render` prop and a module-scope declaration.
      {
        code: `
          const panel = <PortalForwardProvider><div /></PortalForwardProvider>;
          function View() { return <PopoverPrimitive.Popup render={panel} />; }
        `,
        errors: [{ messageId: "providerAsTriggerRender" }],
      },
    ],
  },
);
