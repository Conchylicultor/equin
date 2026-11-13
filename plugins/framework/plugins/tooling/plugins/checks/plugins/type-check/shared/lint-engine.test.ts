// A directive file's verdict, linted in two steps — raw typed parts in a
// program, then `combined` with none — equals ONE whole-file ESLint run with
// the program and every rule (`--quiet`, `reportUnusedDisableDirectives:
// "error"`), on the directive shapes whose answer couples rules: a typed
// problem suppressed, a multi-rule directive half used (one message per unused
// rule) and wholly unused (one message naming both), `eslint-enable` pairing,
// a blanket disable, a directive naming an unknown rule, a warning a directive
// silences (used, though `--quiet` drops the warning), a typed rule set off,
// and a contributed type-aware rule.
//
// Over the repo's real directive files: `../scripts/directive-parity.ts`.

import { describe, expect, it } from "bun:test";
import { join } from "path";
import ts from "typescript";
import { Linter } from "eslint";
import {
  buildLintConfig,
  readDeclaredUtilities,
  typeAwareLintGroups,
} from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { LINT_GROUP_BASE, type RawLintMessage } from "../core";
import { createLintEngine } from "./lint-engine";

const ROOT = REPO_ROOT;
// A web file of a real plugin, in scope for every contributed rule. It need
// not exist: the program reads it from `CASES`.
const DIR = join(ROOT, "plugins/apps/plugins/home/web");

const CASES: Record<string, string> = {
  "typed problem suppressed": `export async function f(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/await-thenable -- fixture
  await 1;
}
`,
  "typed problem not suppressed": `export async function f(): Promise<void> {
  await 1;
}
`,
  "multi-rule directive, one rule used": `export async function f(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/await-thenable, eqeqeq -- fixture
  await 1;
}
`,
  "multi-rule directive, none used": `export const a = 1;
// eslint-disable-next-line @typescript-eslint/await-thenable, eqeqeq -- fixture
export const b = 2;
`,
  "block disable and enable": `/* eslint-disable @typescript-eslint/await-thenable, eqeqeq -- fixture */
export async function f(x: number): Promise<boolean> {
  await 1;
  return x == 1;
}
/* eslint-enable @typescript-eslint/await-thenable, eqeqeq */
/* eslint-enable eqeqeq */
export async function g(): Promise<void> {
  await 2;
}
`,
  "blanket disable": `/* eslint-disable */
export async function f(): Promise<void> {
  await 1;
}
/* eslint-enable */
`,
  "blanket disable, nothing to suppress": `/* eslint-disable */
export const a = 1;
`,
  "unknown rule": `// eslint-disable-next-line nowhere/no-such-rule -- fixture
export const a = 1;
`,
  "silenced warning": `const xs: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- fixture
export const y = xs ? 1 : 2;
`,
  "typed rule set off": `// eslint-disable-next-line @typescript-eslint/no-floating-promises -- fixture
export const p = Promise.resolve(1);
`,
  "disable-line": `export async function f(): Promise<void> {
  await 1; // eslint-disable-line @typescript-eslint/await-thenable -- fixture
  await 2; // eslint-disable-line eqeqeq -- fixture
}
`,
};
const TSX_CASES: Record<string, string> = {
  "contributed type-aware rule": `export function B() {
  return (
    // eslint-disable-next-line button-safety/no-async-raw-button -- fixture
    <button onClick={async () => {}}>x</button>
  );
}
export function C() {
  return <button onClick={async () => {}}>y</button>;
}
`,
};

const fileOf = (name: string, tsx: boolean): string =>
  join(
    DIR,
    `directive-${name.replaceAll(/[^a-z]+/g, "-")}.${tsx ? "tsx" : "ts"}`,
  );

const sources = new Map<string, string>([
  ...Object.entries(CASES).map(([n, c]) => [fileOf(n, false), c] as const),
  ...Object.entries(TSX_CASES).map(([n, c]) => [fileOf(n, true), c] as const),
]);

function program(): ts.Program {
  const read = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT);
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) => {
    const text = sources.get(name);
    return text === undefined
      ? getSourceFile(name, lang, ...rest)
      : ts.createSourceFile(name, text, lang);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => sources.has(name) || fileExists(name);
  return ts.createProgram({ rootNames: [...sources.keys()], options, host });
}

const order = (a: RawLintMessage, b: RawLintMessage): number =>
  a.line - b.line ||
  a.column - b.column ||
  (a.ruleId ?? "").localeCompare(b.ruleId ?? "") ||
  a.message.localeCompare(b.message);

describe("a directive file's verdict, combined with no program", () => {
  it("equals one whole-file run with the program and every rule", async () => {
    const prog = program();
    const declared = readDeclaredUtilities(ROOT);
    const whole = await buildLintConfig({
      root: ROOT,
      typeSource: { programs: [prog] },
      exemptions: { mode: "report" },
      declaredUtilities: declared,
    });
    const aware = await typeAwareLintGroups(declared);
    const typedGroups = [
      ...(aware.base ? [LINT_GROUP_BASE] : []),
      ...aware.contributions,
    ];
    const engine = createLintEngine(ROOT, readDeclaredUtilities(ROOT));
    const linter = new Linter({ configType: "flat" });
    const seen: string[] = [];
    for (const [file, code] of sources) {
      const expected = linter
        .verify(code, whole, { filename: file })
        .filter((m) => m.severity === 2 || m.fatal)
        .map((m) => ({
          ruleId: m.ruleId,
          fatal: m.fatal === true,
          line: m.line,
          column: m.column,
          message: m.message,
        }))
        .sort(order);
      const raw = await engine.typed(prog, file, code, "whole", typedGroups);
      const got = (
        await engine.combined(file, code, Object.values(raw).flat())
      ).sort(order);
      expect(got, file).toEqual(expected);
      seen.push(...got.map((m) => `${m.ruleId ?? "-"}: ${m.message}`));
    }
    // The cases exercise what they name: each coupled report is there.
    const AWAIT =
      '@typescript-eslint/await-thenable: Unexpected `await` of a non-Promise (non-"Thenable") value.';
    expect(seen.filter((m) => !m.startsWith("button-safety/")).sort()).toEqual(
      [
        "-: Unused eslint-disable directive (no problems were reported from '@typescript-eslint/await-thenable' or 'eqeqeq').",
        "-: Unused eslint-disable directive (no problems were reported from '@typescript-eslint/no-floating-promises').",
        "-: Unused eslint-disable directive (no problems were reported from 'eqeqeq').",
        "-: Unused eslint-disable directive (no problems were reported from 'eqeqeq').",
        "-: Unused eslint-disable directive (no problems were reported).",
        "-: Unused eslint-enable directive (no matching eslint-disable directives were found for 'eqeqeq').",
        AWAIT,
        AWAIT,
        AWAIT,
        "nowhere/no-such-rule: Definition for rule 'nowhere/no-such-rule' was not found.",
      ].sort(),
    );
    expect(
      seen.filter((m) => m.startsWith("button-safety/no-async-raw-button:")),
    ).toHaveLength(1);
  }, 120_000);

  it("refuses an inline rule config, which the split cannot answer exactly", async () => {
    const engine = createLintEngine(ROOT, readDeclaredUtilities(ROOT));
    const file = join(DIR, "directive-inline-config.ts");
    // bun settles the promise inside the matcher: no await.
    expect(
      engine.combined(
        file,
        `/* eslint eqeqeq: "off" */\nexport const a = 1;\n`,
        [],
      ),
    ).rejects.toThrow("configures a rule inline");
    // A directive is no inline config.
    expect(
      await engine.combined(
        file,
        `// eslint-disable-next-line eqeqeq -- fixture\nexport const a = 1;\n`,
        [],
      ),
    ).toHaveLength(1);
  }, 120_000);

  it("a raw typed part holds what its directives suppressed, warnings included", async () => {
    const prog = program();
    const engine = createLintEngine(ROOT, readDeclaredUtilities(ROOT));
    const aware = await typeAwareLintGroups(readDeclaredUtilities(ROOT));
    expect(aware.base).toBe(true);
    const suppressed = fileOf("typed problem suppressed", false);
    const raw = await engine.typed(
      prog,
      suppressed,
      sources.get(suppressed)!,
      "whole",
      [LINT_GROUP_BASE],
    );
    expect(raw[LINT_GROUP_BASE]!.map((m) => m.ruleId)).toEqual([
      "@typescript-eslint/await-thenable",
    ]);
    const warned = fileOf("silenced warning", false);
    const rawWarn = await engine.typed(
      prog,
      warned,
      sources.get(warned)!,
      "whole",
      [LINT_GROUP_BASE],
    );
    expect(rawWarn[LINT_GROUP_BASE]!.map((m) => m.ruleId)).toEqual([
      "@typescript-eslint/no-unnecessary-condition",
    ]);
  }, 120_000);
});

// A split file's syntactic groups, answered with no parse when every selected
// rule is off for it by the config's scope: the answer must be exactly what
// ESLint gives that file, the skip only saving the parse.
describe("a split file's syntactic groups", () => {
  const GROUP = "framework/plugins/tooling/plugins/checks/plugins/type-check";
  const CODE = `declare global {
  interface Window {
    probe?: number;
  }
}
export const a = 1;
`;
  const PATHS = [
    // In scope: the rule reports.
    "plugins/apps/plugins/home/web/probe.ts",
    // A test file and an e2e script: the rule is off by its scope.
    "plugins/apps/plugins/home/web/probe.test.ts",
    "plugins/apps/plugins/home/e2e/probe.ts",
  ];

  it("equals one ESLint run of the group's rules, file by file", async () => {
    const engine = createLintEngine(ROOT, readDeclaredUtilities(ROOT));
    const config = await buildLintConfig({
      root: ROOT,
      typeSource: { none: true },
      exemptions: { mode: "report" },
      declaredUtilities: readDeclaredUtilities(ROOT),
      rules: {
        base: false,
        contributions: new Set([GROUP]),
        kind: "syntactic",
      },
    });
    const linter = new Linter({ configType: "flat" });
    const answers: number[] = [];
    for (const path of PATHS) {
      const file = join(ROOT, path);
      const expected = linter
        .verify(CODE, config, { filename: file })
        .filter((m) => m.severity === 2 && m.ruleId !== null)
        .map((m) => `${m.ruleId}@${m.line}:${m.column}`);
      const got = (await engine.syntactic(file, CODE, [GROUP]))[GROUP]!.map(
        (m) => `${m.ruleId}@${m.line}:${m.column}`,
      );
      expect(got).toEqual(expected);
      answers.push(got.length);
    }
    // The fixture exercises both sides: reported in scope, off outside it.
    expect(answers).toEqual([1, 0, 0]);
  });

  it("still parses a file with the base group, whose parse failure it owns", async () => {
    const engine = createLintEngine(ROOT, readDeclaredUtilities(ROOT));
    const out = await engine.syntactic(
      join(ROOT, "plugins/apps/plugins/home/web/probe.test.ts"),
      "export const = ;\n",
      [LINT_GROUP_BASE],
    );
    expect(out[LINT_GROUP_BASE]!.some((m) => m.fatal)).toBe(true);
  });
});
