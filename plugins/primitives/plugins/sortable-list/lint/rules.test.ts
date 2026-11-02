/**
 * Tests for the sortable-list lint rules: `no-scaling-transform` (the dnd-kit
 * `CSS.Transform` serializer that squashes dragged items) and `no-raw-dnd-kit`
 * (imports of @dnd-kit outside the drag primitives; path exemptions live in
 * the owning plugins' `exempt/index.ts`, so every filename here is flagged).
 */

import noScalingTransform from "./no-scaling-transform";
import noRawDndKit from "./no-raw-dnd-kit";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-scaling-transform", noScalingTransform, {
  valid: [
    { code: `const t = CSS.Translate.toString(transform);` },
    { code: `const t = other.Transform.toString(transform);` },
  ],
  invalid: [
    {
      code: `const t = CSS.Transform.toString(transform);`,
      errors: [{ messageId: "scalingTransform" }],
    },
    {
      code: `const f = CSS.Transform;`,
      errors: [{ messageId: "scalingTransform" }],
    },
  ],
});

ruleTester.run("no-raw-dnd-kit", noRawDndKit, {
  valid: [
    {
      code: `import { SortableList } from "@plugins/primitives/plugins/sortable-list/web";`,
    },
    { code: `import x from "dnd-kit-lookalike";` },
  ],
  invalid: [
    {
      code: `import { useSortable } from "@dnd-kit/sortable";`,
      errors: [{ messageId: "rawDndKit" }],
    },
    {
      code: `export { arrayMove } from "@dnd-kit/sortable";`,
      errors: [{ messageId: "rawDndKit" }],
    },
    {
      code: `const m = import("@dnd-kit/core");`,
      errors: [{ messageId: "rawDndKit" }],
    },
  ],
});
