import { describe, it } from "bun:test";
import { RuleTester, type Rule } from "eslint";
import tsParser, { clearCaches } from "@typescript-eslint/parser";
import type { TSESLint } from "@typescript-eslint/utils";

/**
 * The one way a lint-rule test builds its `RuleTester`
 * (`rule-kind-safety/no-raw-rule-tester` rejects a hand-made one). It owns the
 * two pieces of process-wide state a rule test cannot set safely on its own,
 * because `bun test` runs every test file in ONE process:
 *
 * - **The harness.** `RuleTester` registers its cases through its static
 *   `describe` / `it`, which default to globals named `describe` / `it` — and
 *   bun:test injects those into test files, not into eslint's module. A suite
 *   that did not set them ran every case inline while its file loaded: a pass
 *   registered no test at all, a failure was an "unhandled error between
 *   tests" that aborted the rest of the file. Setting them on the base class
 *   from a test file fixed it for that file and, depending on load order, for
 *   whichever ran after it. Here they are bun's own, on this subclass only.
 *
 * - **The project service** (typed suites). typescript-eslint keeps one
 *   project service per process, created by the first parse that asks for one
 *   and kept by every later one — whatever `tsconfigRootDir` /
 *   `allowDefaultProject` the later suite passes, so in a full run every typed
 *   suite but the first failed with "was not found by the project service".
 *   A typed tester here drops a service another tester made before it parses
 *   (`ownProjectService`), and its parser options are fixed — a suite names
 *   only its directory and its virtual cases.
 */
class BunRuleTester extends RuleTester {
  static override get describe() {
    return describe;
  }
  static override get it() {
    return it;
  }
  static override get itOnly() {
    return it.only;
  }

  /** Takes either rule shape — eslint's, or typescript-eslint's `createRule`. */
  override run(
    name: string,
    rule: Rule.RuleModule | TSESLint.RuleModule<string, readonly unknown[]>,
    tests: Parameters<RuleTester["run"]>[2],
  ): void {
    // The two shapes are the same object at runtime; eslint's types only know
    // the legacy one.
    super.run(name, rule as Rule.RuleModule, tests);
  }
}

export type LintRuleTester = BunRuleTester;

interface RuleTesterOptions {
  /**
   * Parse as TSX. Matters for a case without a `filename` (the parser picks
   * the dialect from the extension when there is one): `<T>x` and `<T,>() =>`
   * read differently in the two dialects.
   */
  jsx?: boolean;
}

const languageOptions = ({ jsx = false }: RuleTesterOptions) => ({
  parser: tsParser,
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ...(jsx ? { ecmaFeatures: { jsx: true } } : {}),
  },
});

/** A syntactic rule's tester: no program, no project. */
export function createRuleTester(
  options: RuleTesterOptions = {},
): LintRuleTester {
  return new BunRuleTester({ languageOptions: languageOptions(options) });
}

interface TypedRuleTesterOptions extends RuleTesterOptions {
  /** The directory the virtual cases live in (absolute) — `tsconfigRootDir`. */
  dir: string;
  /**
   * The virtual case files, relative to `dir` (`case.tsx`, `server/case.ts`).
   * Each case's `filename` must be one of them, joined to `dir`; the file need
   * not — and should not — exist on disk.
   */
  cases: readonly string[];
}

/**
 * A type-aware rule's tester. Every case is linted as a path that does NOT
 * exist on disk (`allowDefaultProject` names it), type-checked by TypeScript's
 * project service under an inferred project; each case's source is the
 * virtual file's content. A real fixture file would not do: `type-check`
 * requires every lintable `.ts`/`.tsx` to belong to a tsconfig program, and a
 * fixture project beside the rules is exactly what it refuses.
 *
 * The inferred project's compiler options are `tsconfig.case.json` beside this
 * file — one for every typed suite (DOM and node types, JSX). Two details in it
 * are load-bearing:
 *
 * - `types: ["node"]` — an inferred project otherwise pulls in every `@types`
 *   package it can see, which took a first case from seconds to minutes.
 * - `include: ["*.ts"]` (this folder's sources) — TypeScript refuses a config
 *   whose input set is empty. Only the options are read; those files belong to
 *   the root `tsconfig.json`.
 *
 * The first case of a suite pays for building the program (seconds), so a
 * typed suite raises bun's five-second per-test budget (`setDefaultTimeout`).
 */
export function createTypedRuleTester({
  dir,
  cases,
  ...options
}: TypedRuleTesterOptions): LintRuleTester {
  const base = languageOptions(options);
  return new BunRuleTester({
    languageOptions: {
      ...base,
      parser: ownProjectService(),
      parserOptions: {
        ...base.parserOptions,
        projectService: {
          defaultProject: CASE_TSCONFIG,
          allowDefaultProject: [...cases],
        },
        tsconfigRootDir: dir,
      },
    },
  });
}

/** The typed tester whose parse created the process's project service. */
let serviceOwner: object | undefined;

/**
 * The parser, for one typed tester: before its parse, a project service made
 * for another tester is dropped (`clearCaches`), so the next parse creates one
 * from this tester's options. Keyed on the parse, not on a test hook, so it
 * holds whatever order the suites run in and wherever `run` is called.
 */
function ownProjectService(): typeof tsParser {
  const owner = {};
  const claim = () => {
    if (serviceOwner === owner) return;
    clearCaches();
    serviceOwner = owner;
  };
  return {
    ...tsParser,
    parse: (code, options) => {
      claim();
      return tsParser.parse(code, options);
    },
    parseForESLint: (code, options) => {
      claim();
      return tsParser.parseForESLint(code, options);
    },
  };
}

const CASE_TSCONFIG = new URL("tsconfig.case.json", import.meta.url).pathname;
