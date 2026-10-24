/**
 * Tests for the `no-discarded-link` lint rule — a type-aware rule, on the
 * harness `passthrough/lint/no-unanchored-passthrough.test.ts` explains: each
 * case is linted as a virtual `case.tsx` beside this file, type-checked under
 * an inferred project whose options come from `tsconfig.case.json`.
 *
 * The first invalid case is the acceptance test the rule exists for: the
 * Prototypes gallery's dead Trash button, a `LinkTarget` returned into a
 * component's own `() => void` prop.
 */

import { setDefaultTimeout } from "bun:test";
import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import rule from "./no-discarded-link";

// The first case pays for building the inferred project's program.
setDefaultTimeout(60_000);

const LINT_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const VIRTUAL_CASE = "case.tsx";
const FILENAME = `${LINT_DIR}/${VIRTUAL_CASE}`;

/** The shapes every case builds on: `LinkTarget`, `Activation` and an opener. */
const PRELUDE = `
interface LinkTarget { open(): void; href(): string }
type Action = () => void | undefined;
type Activation = Action | LinkTarget;
interface OpenPaneFn {
  (pane: string, params: object, opts: object): void;
  to(pane: string, params: object, opts: object): LinkTarget;
  link(pane: string, params: object, opts: object): { onClick(): void };
}
declare const openPane: OpenPaneFn;
declare function appLink(url: string): { kind: "app" } & LinkTarget;
declare function Gallery(props: { openTrash: () => void }): null;
declare function Button(props: { onClick?: () => void; children?: unknown }): null;
declare function Chip(props: { activation: Activation }): null;
declare function DataView(props: { rowActivation: (r: { id: string }) => Activation | undefined }): null;
declare function onPick(fn: (id: string) => void): void;
declare const ids: string[];
`;

const valid = (code: string) => ({ filename: FILENAME, code: PRELUDE + code });
const invalid = (code: string, ...messageIds: string[]) => ({
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
        defaultProject: "tsconfig.case.json",
        allowDefaultProject: [VIRTUAL_CASE],
      },
      tsconfigRootDir: LINT_DIR,
    },
  },
});

// `RuleTester.run` drives the harness itself, so it runs at module top level.
ruleTester.run(
  "no-discarded-link",
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // Handed over as data.
      valid(`<Chip activation={openPane.to("p", {}, { mode: "push" })} />;`),
      valid(
        `<DataView rowActivation={(r) => openPane.to("p", { id: r.id }, {})} />;`,
      ),
      valid(`<Chip activation={appLink("/x")} />;`),
      // Kept: assigned, returned from an annotated or a non-void function.
      valid(`const t = openPane.to("p", {}, {}); <Chip activation={t} />;`),
      valid(`let t: LinkTarget; t = openPane.to("p", {}, {});`),
      valid(`function f(): LinkTarget { return openPane.to("p", {}, {}); }`),
      valid(`const make = (id: string) => openPane.to("p", { id }, {});`),
      valid(`ids.map((id) => openPane.to("p", { id }, {}));`),
      // Spread as a link, run, or an imperative open.
      valid(`<Button {...openPane.link("p", {}, {})} />;`),
      valid(`<Button onClick={() => openPane.to("p", {}, {}).open()} />;`),
      valid(`onPick((id) => openPane("p", { id }, {}));`),
      valid(`<Gallery openTrash={() => openPane("t", {}, {})} />;`),
      // A void callback returning something that is not a link.
      valid(`<Button onClick={() => ids.push("x")} />;`),
      // A function value returning no link, into a void prop.
      valid(`const go = () => {}; <Button onClick={go} />;`),
    ],
    invalid: [
      // The Prototypes Trash button.
      invalid(
        `<Gallery openTrash={() => openPane.to("t", {}, { mode: "push" })} />;`,
        "voidReturn",
      ),
      invalid(`<Button onClick={() => appLink("/x")} />;`, "voidReturn"),
      invalid(
        `<Button onClick={function () { return openPane.to("p", {}, {}); }} />;`,
        "voidReturn",
      ),
      invalid(
        `onPick((id) => { return openPane.to("p", { id }, {}); });`,
        "voidReturn",
      ),
      invalid(
        `ids.forEach((id) => openPane.to("p", { id }, {}));`,
        "voidReturn",
      ),
      invalid(
        `const props: { onClick: () => void } = { onClick: () => openPane.to("p", {}, {}) };`,
        "voidReturn",
      ),
      // A bare statement, `void`ed or not.
      invalid(`openPane.to("p", {}, {});`, "statement"),
      invalid(`void appLink("/x");`, "statement"),
      // A named handler into a void prop / argument.
      invalid(
        `const go = () => openPane.to("p", {}, {}); <Button onClick={go} />;`,
        "voidCallback",
      ),
      invalid(
        `const go = (id: string) => openPane.to("p", { id }, {}); onPick(go);`,
        "voidCallback",
      ),
    ],
  },
);
