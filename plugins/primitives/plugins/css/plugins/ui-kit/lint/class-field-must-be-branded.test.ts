/**
 * Tests for the `class-field-must-be-branded` lint rule. Run with `bun test`
 * from the repo root (or this file's directory).
 *
 * The gate is the NAME: only a compound `*ClassName` / `*ClassNames` / `*Classes`
 * field is asked to be branded. Bare `className` is React's DOM prop — already
 * read at the JSX site by every class rule, and carried by every
 * `icon: ComponentType<{ className?: string }>` in the repo — so excluding it is
 * what keeps this rule's false-positive rate at zero. That case is the first
 * valid fixture below, deliberately.
 */

import rule from "./class-field-must-be-branded";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("class-field-must-be-branded", rule, {
  valid: [
    // THE case the whole name gate is built around: React's own prop, on the
    // icon-component shape that appears throughout the repo.
    `interface Props { icon: ComponentType<{ className?: string }> }`,
    // Bare className anywhere — a plain prop, a class field, a method return.
    `interface Props { className?: string }`,
    `class Box { className: string = ""; }`,
    // A compound field that IS branded.
    `interface Props { panelClassName?: ClassName }`,
    `interface Props { badgeClassName: ClassName }`,
    // Branded in a union with nothing but nullish arms.
    `interface Props { labelClassName?: ClassName | null }`,
    `interface Props { labelClassName: ClassName | null | undefined }`,
    // A per-row resolver: what it RETURNS is what carries classes.
    `interface Props { labelClassName?: (row: R) => ClassName | undefined }`,
    // The method spelling of the same resolver.
    `interface Props { labelClassName(row: R): ClassName }`,
    // Branded class field.
    `class Box { boxClassName: ClassName = cn(""); }`,
    // Non-class fields that merely end in something similar.
    `interface Props { classification?: string }`,
    `interface Props { tintClass?: string }`,
    // A compound name with no annotation declares no shape to relocate.
    `class Box { panelClassName = cn("flex"); }`,
    // Computed keys are not statically readable, so they are left alone.
    `interface Props { [KEY]: string }`,
  ],
  invalid: [
    // The plain-string data field — the hole the brand exists to close.
    {
      code: `interface Props { panelClassName?: string }`,
      errors: [{ messageId: "unbrandedClassField" }],
    },
    // Required, not optional.
    {
      code: `interface Props { containerClassName: string }`,
      errors: [{ messageId: "unbrandedClassField" }],
    },
    // The plural spellings are covered by the same gate.
    {
      code: `interface Props { iconClassNames?: string }`,
      errors: [{ messageId: "unbrandedClassField" }],
    },
    {
      code: `interface Props { rowClasses?: string }`,
      errors: [{ messageId: "unbrandedClassField" }],
    },
    // `string | ClassName` is a `string` — one unbranded arm reopens the hole.
    {
      code: `interface Props { labelClassName?: string | ClassName }`,
      errors: [{ messageId: "unbrandedClassField" }],
    },
    // A nullable plain string is still a plain string.
    {
      code: `interface Props { labelClassName: string | null }`,
      errors: [{ messageId: "unbrandedClassField" }],
    },
    // A resolver returning a bare string.
    {
      code: `interface Props { labelClassName?: (row: R) => string | undefined }`,
      errors: [{ messageId: "unbrandedClassField" }],
    },
    // The method spelling of the same mistake.
    {
      code: `interface Props { labelClassName(row: R): string }`,
      errors: [{ messageId: "unbrandedClassField" }],
    },
    // A class field declaring the unbranded shape.
    {
      code: `class Box { panelClassName: string = ""; }`,
      errors: [{ messageId: "unbrandedClassField" }],
    },
    // A published type alias is a shape too.
    {
      code: `type rowClassName = string;`,
      errors: [{ messageId: "unbrandedClassField" }],
    },
  ],
});
