/**
 * Tests for the `no-redundant-cursor-pointer` lint rule.
 *
 * The rule flags `cursor-pointer` written on a control the base layer already
 * covers, and must stay quiet on the two things that are NOT redundant: a plain
 * container that happens to be clickable (a `<div onClick>`, a `<tr>`, a `Row`,
 * whose element only its own props decide), and `cursor-default`, which is how
 * a control opts back out.
 */

import rule from "./no-redundant-cursor-pointer";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-redundant-cursor-pointer", rule, {
  valid: [
    // A plain div that happens to be clickable: nothing in the base layer
    // reaches it, so the class is the only thing doing the job.
    { code: `const el = <div onClick={go} className="cursor-pointer" />;` },
    {
      code: `const el = <tr onClick={go} className="cursor-pointer border-b" />;`,
    },
    // `Row` renders a <button> only when it has an onClick — its own props
    // decide, so the rule does not guess.
    {
      code: `const el = <Row onClick={go} className="min-h-7 cursor-pointer" />;`,
    },
    // Opting out is still allowed, on a button or anywhere else.
    { code: `const el = <button className="w-full cursor-default" />;` },
    // A word that merely contains the class name is not the class.
    { code: `const el = <button className="group-cursor-pointerish" />;` },
    // A label with no checkbox inside is not covered, so not redundant.
    {
      code: `const el = <label className="cursor-pointer"><span>x</span></label>;`,
    },
  ],
  invalid: [
    // Literal tags.
    {
      code: `const el = <button className="w-full cursor-pointer text-left" />;`,
      errors: [{ messageId: "redundant" }],
    },
    {
      code: `const el = <summary className="cursor-pointer" />;`,
      errors: [{ messageId: "redundant" }],
    },
    // role / as, on any tag.
    {
      code: `const el = <span role="button" className="cursor-pointer rounded-sm" />;`,
      errors: [{ messageId: "redundant" }],
    },
    {
      code: `const el = <Badge as="button" className="cursor-pointer hover:text-destructive" />;`,
      errors: [{ messageId: "redundant" }],
    },
    // The shared components.
    {
      code: `const el = <IconButton className="cursor-pointer" />;`,
      errors: [{ messageId: "redundant" }],
    },
    // Clickable input types.
    {
      code: `const el = <input type="checkbox" className="size-4 cursor-pointer accent-primary" />;`,
      errors: [{ messageId: "redundant" }],
    },
    // A label around a checkbox, however deep the checkbox sits.
    {
      code: `const el = (
          <label className="cursor-pointer">
            <Stack><input type="checkbox" onChange={t} /><span>x</span></Stack>
          </label>
        );`,
        errors: [{ messageId: "redundant" }],
      },
      // Behind a variant, inside cn(), and inside a template — still the class.
      {
        code: `const el = <button className="hover:cursor-pointer" />;`,
        errors: [{ messageId: "redundant" }],
      },
      {
        code: `const el = <button className={cn("rounded-md", active && "cursor-pointer")} />;`,
        errors: [{ messageId: "redundant" }],
      },
      {
        // A template literal, written as one here (the escapes keep the
        // interpolation part of the FIXTURE rather than of this file).
        code: `const el = <button className={\`px-2 cursor-pointer \${extra}\`} />;`,
        errors: [{ messageId: "redundant" }],
      },
    ],
  },
);
