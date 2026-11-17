/**
 * Tests for the `no-dead-timing` lint rule: a `duration-*` / `ease-*` /
 * `delay-*` on an intrinsic element with nothing that transitions or animates
 * beside it is flagged; one beside a `transition-*`, an `animate-*` or an
 * animating app.css @utility, or on a component, is not.
 */

import {
  createRuleTester,
  lintToolkit,
} from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-dead-timing";

const rule = buildRule(lintToolkit);

const ruleTester = createRuleTester({ jsx: true });

const dead = (token: string) => ({
  messageId: "deadTiming" as const,
  data: { token },
});

// `RuleTester.run` registers bun:test cases, so it runs at module top level.
ruleTester.run("no-dead-timing", rule, {
  valid: [
    `const a = <div className="transition-opacity duration-150" />;`,
    `const a = <div className="transition duration-200 ease-in-out" />;`,
    `const a = <div className="animate-spin duration-700" />;`,
    // An animating @utility declared in app.css.
    `const a = <div className="data-open:overlay-enter duration-100" />;`,
    // The mover in one branch, the timing in another — one element.
    `const a = <div className={cn("transition-opacity", open ? "opacity-100 delay-150 duration-250" : "opacity-0 duration-150")} />;`,
    // A component may add the transition itself.
    `const a = <SheetContent className="duration-300" />;`,
    // Retargeted to a pseudo-element along with its transition.
    `const a = <div className="after:transition-opacity after:duration-200" />;`,
    // Not a timing class.
    `const a = <div className="w-4 opacity-50" />;`,
  ],
  invalid: [
    {
      code: `const a = <div className="w-4 duration-100" />;`,
      errors: [dead("duration-100")],
    },
    {
      code: `const a = <div className={cn("opacity-0", open && "opacity-100 ease-out delay-75")} />;`,
      errors: [dead("ease-out"), dead("delay-75")],
    },
    // `transition-none` moves nothing.
    {
      code: `const a = <span className="transition-none duration-200" />;`,
      errors: [dead("duration-200")],
    },
    // A plain @utility (no transition/animation in its body) moves nothing.
    {
      code: `const a = <div className="rounded-card duration-100" />;`,
      errors: [dead("duration-100")],
    },
    // A same-file alias is read like an inline literal.
    {
      code: `const C = "z-popover duration-100"; const a = <div className={C} />;`,
      errors: [dead("duration-100")],
    },
  ],
});
