/**
 * Tests for the `no-groupless-dropdown-menu-label` lint rule. Run with `bun test`
 * from the repo root (or this file's directory).
 *
 * The rule bans a `<DropdownMenuLabel>` with no enclosing `<DropdownMenuGroup>` /
 * `<DropdownMenuSection>` in the same component — base-ui's `Menu.GroupLabel`
 * hard-crashes (#31 useMenuGroupRootContext) without a `Menu.Group` context. The
 * tricky cases this file locks in: a group ancestor several levels up (through a
 * fragment) is valid; `DropdownMenuSection` counts as a valid group ancestor; a
 * non-JSX `DropdownMenuLabel` reference must not trip; and a label in a separate
 * component from an outer group is INVALID (function boundary).
 */

import rule from "./no-groupless-dropdown-menu-label";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-groupless-dropdown-menu-label", rule, {
  valid: [
    // Label directly inside a group.
    {
      code: `const el = <DropdownMenuGroup><DropdownMenuLabel>Hi</DropdownMenuLabel></DropdownMenuGroup>;`,
    },
    // Label nested deeper (through a fragment) inside a group.
    {
      code: `const el = <DropdownMenuGroup><><DropdownMenuLabel>Hi</DropdownMenuLabel></></DropdownMenuGroup>;`,
    },
    // A DropdownMenuSection with no raw label — nothing to report.
    {
      code: `const el = <DropdownMenuSection label="Hi"><DropdownMenuItem/></DropdownMenuSection>;`,
    },
    // DropdownMenuSection counts as a valid group ancestor for a raw label.
    {
      code: `const el = <DropdownMenuSection label="x"><DropdownMenuLabel>y</DropdownMenuLabel></DropdownMenuSection>;`,
    },
    // A `DropdownMenuLabel` identifier that is not JSX must not trip.
    { code: `const x = DropdownMenuLabel; foo(DropdownMenuLabel);` },
  ],
  invalid: [
    // Label directly under content, no group.
    {
      code: `const el = <DropdownMenuContent><DropdownMenuLabel>Hi</DropdownMenuLabel></DropdownMenuContent>;`,
      errors: [{ messageId: "grouplessLabel" }],
    },
    // Bare label at the top of a JSX return.
    {
      code: `const el = <DropdownMenuLabel>Hi</DropdownMenuLabel>;`,
      errors: [{ messageId: "grouplessLabel" }],
    },
    // Label in a SEPARATE component from the group (function boundary).
    {
      code: `function Inner(){ return <DropdownMenuLabel>x</DropdownMenuLabel>; } function Outer(){ return <DropdownMenuGroup><Inner/></DropdownMenuGroup>; }`,
      errors: [{ messageId: "grouplessLabel" }],
    },
  ],
});
