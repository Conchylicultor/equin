/**
 * Directive parity over the repo's REAL directive files: for every lintable
 * file whose text can carry an eslint directive, the verdict the type-check
 * lint engine assembles — raw typed parts in a program, then `combined` with
 * none (`../shared/lint-engine.ts`) — against ONE whole-file ESLint run with
 * the program and every rule (`--quiet`: error-level and fatal only;
 * `reportUnusedDisableDirectives: "error"` from the config builder). Prints
 * every file whose two answers differ, and exits 1 when one does.
 *
 *   ./equin run plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/scripts/directive-parity.ts [--chunk 40] [--only <substring>]
 *
 * Files are checked in programs of `--chunk` roots (their import closures as
 * source): a one-off proof, not a check — it builds programs the check would
 * serve as stored `.d.ts`. The fixture cases are `../shared/lint-engine.test.ts`.
 */

import { join } from "path";
import ts from "typescript";
import { Linter } from "eslint";
import { loadRepoFiles } from "@plugins/framework/plugins/tooling/core";
import {
  buildLintConfig,
  isLintScopeExcluded,
  readDeclaredUtilities,
  typeAwareLintGroups,
} from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { LINT_GROUP_BASE, type RawLintMessage } from "../core";
import { createLintEngine } from "../shared/lint-engine";

const root = asAppPath(process.cwd());
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const chunk = Number(arg("chunk") ?? "40");
const only = arg("only");

// `check/fingerprint.ts` `hasLintDirective` and `check/lint-universe.ts`
// `isLintable` (a leaf folder: restated, not imported).
const hasLintDirective = (src: string): boolean =>
  /eslint-(?:disable|enable)|\/\*\s*eslint\s/.test(src);
const isLintable = (rel: string): boolean =>
  (rel.endsWith(".ts") || rel.endsWith(".tsx")) && !isLintScopeExcluded(rel);

const order = (a: RawLintMessage, b: RawLintMessage): number =>
  a.line - b.line ||
  a.column - b.column ||
  (a.ruleId ?? "").localeCompare(b.ruleId ?? "") ||
  a.message.localeCompare(b.message);
const show = (m: RawLintMessage): string =>
  `${m.line}:${m.column} ${m.ruleId ?? "-"} ${m.message}`;

const files: { rel: string; code: string }[] = [];
for (const rel of [...(await loadRepoFiles(root)).all()].sort()) {
  if (!isLintable(rel) || (only !== undefined && !rel.includes(only))) continue;
  const code = await readFile(join(root, rel), "utf8");
  if (hasLintDirective(code)) files.push({ rel, code });
}
console.log(
  `directive-parity: ${files.length} directive files, programs of ${chunk}`,
);

const parsed = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile).config,
  ts.sys,
  root,
);
const declared = readDeclaredUtilities(root);
const aware = await typeAwareLintGroups(declared);
const typedGroups = [
  ...(aware.base ? [LINT_GROUP_BASE] : []),
  ...[...aware.contributions].sort(),
];
const linter = new Linter({ configType: "flat" });

let differ = 0;
let messages = 0;
const t0 = performance.now();
for (let i = 0; i < files.length; i += chunk) {
  const batch = files.slice(i, i + chunk);
  const program = ts.createProgram({
    rootNames: batch.map((f) => join(root, f.rel)),
    options: parsed.options,
  });
  const whole = await buildLintConfig({
    root,
    typeSource: { programs: [program] },
    exemptions: { mode: "report" },
    declaredUtilities: declared,
  });
  // One engine per program: its typed configs hold the program.
  const engine = createLintEngine(root, readDeclaredUtilities(root));
  for (const { rel, code } of batch) {
    const file = join(root, rel);
    const expected = linter
      .verify(code, whole, { filename: file })
      .filter((m) => m.severity === 2 || m.fatal)
      .map((m): RawLintMessage => ({
        ruleId: m.ruleId,
        fatal: m.fatal === true,
        line: m.line,
        column: m.column,
        message: m.message,
      }))
      .sort(order);
    const raw = await engine.typed(program, file, code, "whole", typedGroups);
    const got = (
      await engine.combined(file, code, Object.values(raw).flat())
    ).sort(order);
    messages += expected.length;
    const a = expected.map(show).join("\n");
    const b = got.map(show).join("\n");
    if (a !== b) {
      differ++;
      console.log(
        `DIFFERS ${rel}\n  whole:\n    ${a.replaceAll("\n", "\n    ")}\n  combined:\n    ${b.replaceAll("\n", "\n    ")}`,
      );
    }
  }
  console.log(
    `directive-parity: ${Math.min(i + chunk, files.length)}/${files.length} files, ${differ} differ (${Math.round((performance.now() - t0) / 1000)}s)`,
  );
}
console.log(
  `directive-parity: ${files.length} files, ${messages} verdict messages, ${differ} differ`,
);
process.exit(differ === 0 ? 0 : 1);
