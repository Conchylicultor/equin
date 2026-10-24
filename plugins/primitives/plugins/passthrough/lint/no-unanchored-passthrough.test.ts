/**
 * Tests for the `no-unanchored-passthrough` lint rule. Run with
 * `./equin test plugins/primitives/plugins/passthrough`.
 *
 * ## The harness — the repo's first type-aware rule test
 *
 * The rule asks the TypeScript checker whether a component's props type has a
 * string index signature, so `RuleTester` has to hand the parser a real
 * program, not just a parser. Nothing here did that before — the other
 * type-aware rule, `button-safety/no-async-raw-button`, ships no test at all —
 * so this file is the precedent, and the shape is worth explaining.
 *
 * Each case is linted as a path that **does not exist on disk** (`case.tsx`
 * beside this file), type-checked through TypeScript's project service under an
 * inferred project. `projectService.allowDefaultProject` names that virtual
 * path, and `defaultProject` points at `tsconfig.case.json`, which is read for
 * its compiler options and nothing else. Each case's source IS the virtual
 * file's content, so there is nothing on disk to keep in step with it.
 *
 * That little config is a config, not a source file, and that is the whole
 * point: `type-check` requires every lintable `.ts`/`.tsx` in the repo to
 * belong to a tsconfig program, so the winning move is to have no `.tsx` to
 * place. Two details in it are load-bearing:
 *
 * - `types: []` — an inferred project otherwise pulls in every `@types` package
 *   it can see. With the repo root as the project root that took the first case
 *   from three seconds to five minutes.
 * - `include: ["*.ts"]` (this folder's rule sources) — TypeScript refuses to
 *   parse a config whose input set is empty, and typescript-eslint reports that
 *   as "Unable to parse the specified 'tsconfig' file". The inputs are never
 *   compiled; only the options are read. Those files already belong to the root
 *   `tsconfig.json` — the repo's one program — which is what type-checks and
 *   lints them; nothing discovers this config but this test.
 *
 * The first attempt was a small fixture project checked in beside this file
 * (`lint/fixtures/tsconfig.json` plus an empty `file.tsx` whose bytes the
 * RuleTester substituted). It worked, and it failed
 * `./equin check type-check`: a `.tsx` in the repo that no tsconfig
 * program covers is invisible to type-checking and linting, and the check says
 * so out loud. The fix was to stop needing a file on disk, not to exempt one.
 *
 * `@typescript-eslint/rule-tester` has type-aware support built in and would be
 * the obvious third option; it is not a dependency of this repo, and the
 * project service reaches the same place with the packages already installed.
 *
 * Each case is prefixed with {@link PRELUDE} so the snippets declare a real open
 * props type — the rule would otherwise skip every one of them at the type gate,
 * and the suite would pass while testing nothing. The closed-type case
 * (`PlainProps`) is the negative control that pins the gate actually gating.
 *
 * The first invalid case is the acceptance test the rule exists for: the
 * historical `Row` / `ViewportOverlay` shape, with `ref` on an outer wrapper and
 * `{...rest}` on an inner element.
 */

import { setDefaultTimeout } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-unanchored-passthrough";

// The FIRST case pays for building the program behind the inferred project —
// seconds, and more on a loaded machine — while bun:test's default per-test
// budget is five. Every case after it is milliseconds. Raising the budget is the
// honest fix: the alternative (a warm-up outside the suite) hides the cost
// rather than paying it.
setDefaultTimeout(60_000);

/** This directory — where `tsconfig.case.json` and the virtual case both sit. */
const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

/**
 * The path every case is linted AS. Nothing exists there, and nothing should:
 * a real `.tsx` sitting beside the rules would belong to no tsconfig program,
 * which is precisely what `type-check` fails on.
 */
const VIRTUAL_CASE = "case.tsx";
const FILENAME = `${LINT_DIR}/${VIRTUAL_CASE}`;

/**
 * Declarations every case builds on: the passthrough marker (an open props
 * type — what the checker gate looks for), a plain closed props type for the
 * negative control, and `splitPassthrough`'s signature.
 */
const PRELUDE = `
declare function splitPassthrough(
  rest: Record<string, unknown>,
  isRouted: (key: string) => boolean,
): { anchored: Record<string, unknown>; routed: Record<string, unknown> };
declare function isControlKey(key: string): boolean;
declare function useCallback<T>(fn: T, deps: unknown[]): T;
interface Passthrough { ref?: unknown; [key: string]: unknown }
interface BoxProps extends Passthrough { children?: unknown }
interface PlainProps { title?: string; children?: unknown }
`;

const valid = (code: string) => ({ filename: FILENAME, code: PRELUDE + code });
const invalid = (code: string, messageIds: string[]) => ({
  filename: FILENAME,
  code: PRELUDE + code,
  errors: messageIds.map((messageId) => ({ messageId })),
});

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      ecmaFeatures: { jsx: true },
      projectService: {
        // Read for its compiler options only — `files: []` means it claims no
        // file, so the virtual case falls through to the inferred project. It
        // also declares `types: []`, which is the difference between a suite
        // that runs in seconds and one that spends five minutes pulling every
        // `@types` package in the repo into an inferred project.
        defaultProject: "tsconfig.case.json",
        allowDefaultProject: [VIRTUAL_CASE],
      },
      tsconfigRootDir: LINT_DIR,
    },
  },
});

// `RuleTester.run` drives the harness itself (it calls the ambient describe/it
// that bun:test provides), so it must run at module top level — never inside
// test().
ruleTester.run(
  "no-unanchored-passthrough",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // `Badge`: two host elements, no `ref` destructured, one spread. Correct —
      // `ref` rides inside the bag, so it lands wherever the bag lands.
      valid(
        `export function Badge({ children, ...rest }: BoxProps) {
           return <span {...rest}><span className="truncate">{children}</span></span>;
         }`,
      ),
      // The anchor wrapped in new chrome. `ref` and the bag stay together, which
      // is the growth case the contract is designed to make harmless.
      valid(
        `export function Surface({ ref, children, ...rest }: BoxProps) {
           return <div className="frame"><div ref={ref} {...rest}>{children}</div></div>;
         }`,
      ),
      // A composed callback ref counts: the rule checks that a `ref` attribute is
      // THERE, never what its expression does (`OverlayPanel` merges the caller's
      // ref with two internal ones exactly like this).
      valid(
        `export function OverlayPanel({ ref, children, ...rest }: BoxProps) {
           const panelRef = useCallback((el: unknown) => { measure(el); }, []);
           return <div ref={panelRef} {...rest}>{children}</div>;
         }`,
      ),
      // `Row`'s shape: the split is NAMED, `anchored` lands on the `ref` element,
      // and `routed` is free to go to the synthesized control.
      valid(
        `export function Row({ ref, children, ...rest }: BoxProps) {
           const { anchored: boxProps, routed: controlProps } = splitPassthrough(rest, isControlKey);
           return (
             <div ref={ref} {...boxProps}>
               <button {...controlProps}>{children}</button>
             </div>
           );
         }`,
      ),
      // `routed` is deliberately unconstrained — naming it IS the statement that
      // it goes somewhere else, including to more than one somewhere.
      valid(
        `export function Split({ ref, ...rest }: BoxProps) {
           const { anchored, routed } = splitPassthrough(rest, isControlKey);
           return (
             <div ref={ref} {...anchored}>
               <button {...routed} />
               <a {...routed} />
             </div>
           );
         }`,
      ),
      // `Row`'s two render paths: one tree for the plain row, another for the
      // row that carries actions, each spreading the SAME bag on its own single
      // node. One destination written twice — never a fan-out.
      valid(
        `export function Row({ ref, children, ...rest }: BoxProps) {
           if (children) {
             return <div ref={ref} {...rest}><span>{children}</span></div>;
           }
           return <div ref={ref} {...rest} />;
         }`,
      ),
      // Same argument one level down: opposite arms of a ternary.
      valid(
        `export function Chip({ ref, children, ...rest }: BoxProps) {
           return children ? <a ref={ref} {...rest} /> : <span ref={ref} {...rest} />;
         }`,
      ),
      // Closed props type — no passthrough, nothing to anchor. The rest binding
      // here is an ordinary object and may be picked apart freely.
      valid(
        `export function Plain({ title, ...rest }: PlainProps) {
           const entries = Object.entries(rest);
           return <div title={title}>{entries.length}</div>;
         }`,
      ),
      // `ToggleChip`'s shape: asking the bag for one named key decides whether to
      // add an attribute of the primitive's own. It inspects the bag; the bag
      // still goes whole onto one element.
      valid(
        `export function ToggleChip({ children, ...rest }: BoxProps) {
           const pressed = rest.role === undefined ? true : undefined;
           return <button aria-pressed={pressed} {...rest}>{children}</button>;
         }`,
      ),
      // Not a component: a lowercase helper is not held to the contract.
      valid(
        `export function describeBag({ ref, ...rest }: BoxProps) {
           return Object.keys(rest).length;
         }`,
      ),
    ],
    invalid: [
      // THE historical bug: `ref` names the outer wrapper, the bag addresses an
      // inner element. A caller's `data-*` selector target and the node they hold
      // are two different elements.
      invalid(
        `export function Row({ ref, children, ...rest }: BoxProps) {
           return <div ref={ref}><span {...rest}>{children}</span></div>;
         }`,
        ["restOffRef"],
      ),
      // Deriving from the bag by hand — how `Row` used to route, and unreadable
      // to this rule.
      invalid(
        `export function Row({ ref, ...rest }: BoxProps) {
           const boxProps: Record<string, unknown> = {};
           for (const [key, value] of Object.entries(rest)) boxProps[key] = value;
           return <div ref={ref} {...boxProps} />;
         }`,
        ["restEscaped"],
      ),
      // Copying the bag into a local is the same escape in one line.
      invalid(
        `export function Card({ ref, ...rest }: BoxProps) {
           const merged = { ...rest, className: "card" };
           return <div ref={ref} {...merged} />;
         }`,
        ["restEscaped"],
      ),
      // Handing the bag to a helper moves the destination out of the file.
      invalid(
        `export function Card({ ref, ...rest }: BoxProps) {
           return <div ref={ref} {...pick(rest)} />;
         }`,
        ["restEscaped"],
      ),
      // A DYNAMIC key is not a named read — that is the hand-rolled routing loop
      // wearing a different hat.
      invalid(
        `export function Row({ ref, ...rest }: BoxProps) {
           const boxProps: Record<string, unknown> = {};
           for (const key of Object.keys({})) boxProps[key] = rest[key];
           return <div ref={ref} {...boxProps} />;
         }`,
        ["restEscaped"],
      ),
      // Writing INTO the bag is not a read of it.
      invalid(
        `export function Row({ ref, ...rest }: BoxProps) {
           rest.role = "row";
           return <div ref={ref} {...rest} />;
         }`,
        ["restEscaped"],
      ),
      // One bag, one element. (No `ref` destructured here, so this isolates the
      // fan-out from the anchoring check.)
      invalid(
        `export function Badge({ children, ...rest }: BoxProps) {
           return <span {...rest}><span {...rest}>{children}</span></span>;
         }`,
        ["restFannedOut"],
      ),
      // `&&` is not an exclusive branch — both elements render, so this really is
      // two destinations.
      invalid(
        `export function Badge({ children, ...rest }: BoxProps) {
           return <span {...rest}>{children ? <b {...rest} /> : null}</span>;
         }`,
        ["restFannedOut"],
      ),
      // A declared split does not license moving the anchored half off the node:
      // it is the part that still keeps the promise.
      invalid(
        `export function Row({ ref, children, ...rest }: BoxProps) {
           const { anchored: boxProps, routed: controlProps } = splitPassthrough(rest, isControlKey);
           return (
             <div ref={ref}>
               <span {...boxProps} />
               <button {...controlProps}>{children}</button>
             </div>
           );
         }`,
        ["anchoredOffRef"],
      ),
      // …nor spreading it twice.
      invalid(
        `export function Row({ ref, ...rest }: BoxProps) {
           const { anchored } = splitPassthrough(rest, isControlKey);
           return <div ref={ref} {...anchored}><span {...anchored} /></div>;
         }`,
        ["anchoredOffRef"],
      ),
    ],
  },
);
