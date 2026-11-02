/**
 * Tests for the `no-split-slot-row` lint rule.
 *
 * The rule flags two DIFFERENT render slots whose nearest common JSX ancestor
 * is a single-row container — the "second slot for the right-hand items" split
 * that a spacer node in the one slot's order config replaces.
 */

import rule from "./no-split-slot-row";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-split-slot-row", rule, {
  valid: [
    // One slot, split by a spacer in its config — the intended shape.
    { code: `const el = <Line><Header.Render /></Line>;` },
    // The same slot twice is not a split.
    { code: `const el = <Line><A.Render /><A.Render /></Line>;` },
    // Slots stacked in a column are separate regions.
    {
      code: `const el = <Stack direction="column"><A.Render /><B.Render /></Stack>;`,
    },
    // A bare Stack defaults to a column.
    { code: `const el = <Stack><A.Render /><B.Render /></Stack>;` },
    // Row-ness is decided at the NEAREST common ancestor: here a column.
    {
      code: `const el = <Line><Stack><A.Render /><B.Render /></Stack></Line>;`,
    },
    // Separate render-props (a tree row's accent / trailing callbacks) are
    // separate renders, not siblings.
    {
      code: `const cfg = { accent: () => <Inline><A.Render /></Inline>, trailing: () => <Inline><B.Render /></Inline> };`,
    },
    // A non-Render member tag.
    { code: `const el = <Line><A.Mount /><B.Render /></Line>;` },
  ],
  invalid: [
    // The conversation header split verbatim — the shape this rule exists for.
    {
      code: `const el = (
          <Stack as="span" direction="row" gap="sm" align="center">
            <Fill as="span">
              <CollapsibleWrap rows={1} gap={6}>
                <Conversation.Header.Render>{(item) => <item.component />}</Conversation.Header.Render>
              </CollapsibleWrap>
            </Fill>
            <Rigid as="span">
              <Stack as="span" direction="row" gap="xs" align="center">
                <Conversation.HeaderEnd.Render>{(item) => <item.component />}</Conversation.HeaderEnd.Render>
              </Stack>
            </Rigid>
          </Stack>
        );`,
        errors: [{ messageId: "splitSlotRow" }],
      },
      // Direct siblings in a Line.
      {
        code: `const el = <Line><Start.Render /><Fill /><End.Render /></Line>;`,
        errors: [{ messageId: "splitSlotRow" }],
      },
      // Through a conditional.
      {
        code: `const el = <Bar><A.Render />{show && <B.Render />}</Bar>;`,
        errors: [{ messageId: "splitSlotRow" }],
      },
      // Three slots in one row: each extra slot is reported once.
      {
        code: `const el = <Inline><A.Render /><B.Render /><C.Render /></Inline>;`,
        errors: [{ messageId: "splitSlotRow" }, { messageId: "splitSlotRow" }],
      },
    ],
  },
);
