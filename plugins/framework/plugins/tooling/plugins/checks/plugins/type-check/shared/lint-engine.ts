// HOW a file is linted — one copy, shared by the worker (`./worker.ts`) and the
// batch processes (`./batch-worker.ts`): the rule configs per (program, kind,
// group set), the `--quiet` filter, and the grouping of messages by rule group.
// WHICH parts run is decided elsewhere (`./lint-decisions.ts`).

import ts from "typescript";
import { Linter } from "eslint";
import {
  buildLintConfig,
  loadLintContributions,
} from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { LINT_GROUP_ALL, LINT_GROUP_BASE, type RawLintMessage } from "../core";

/** What to lint of one file: its unit, its stale syntactic groups, its typed groups. */
export interface LintSpec {
  unit: "split" | "whole";
  /** Syntactic groups to run with no program (`split` only). */
  syntactic: string[];
  /** Typed parts to run in the program: groups, or `LINT_GROUP_ALL` for `whole`. */
  typed: string[];
}

/** One file's messages, by group. */
export interface LintOut {
  typed: Record<string, RawLintMessage[]>;
  syntactic: Record<string, RawLintMessage[]>;
}

export interface LintEngine {
  /** A file's typed parts, inside `program` (which holds it as source). */
  typed(
    program: ts.Program,
    file: string,
    code: string,
    unit: "split" | "whole",
    groups: readonly string[],
  ): Promise<Record<string, RawLintMessage[]>>;
  /** A file's syntactic groups, with no program. */
  syntactic(
    file: string,
    code: string,
    groups: readonly string[],
  ): Promise<Record<string, RawLintMessage[]>>;
  /** Both, for every file of `specs` (absolute path → spec). */
  files(
    program: ts.Program,
    specs: ReadonlyMap<string, LintSpec>,
    read: (file: string) => string,
  ): Promise<Map<string, LintOut>>;
}

export function createLintEngine(root: string): LintEngine {
  // A rule id's namespace is its contribution's `name`; anything else (the
  // config builder's own typescript-eslint / react-hooks / core rules) and a
  // null id (the linter itself: a parse failure) belong to the base group.
  // Loaded on the first file that lints: a run with nothing to lint (most)
  // never pays for the rules.
  let groupOfNamespace: Map<string, string> | undefined;
  const loadGroups = async (): Promise<void> => {
    groupOfNamespace ??= new Map(
      (await loadLintContributions(root)).map(
        (c) => [c.name, c.relPath] as const,
      ),
    );
  };
  const groupOf = (ruleId: string | null): string => {
    if (ruleId === null) return LINT_GROUP_BASE;
    if (groupOfNamespace === undefined) {
      throw new Error("lint engine: rule groups read before they were loaded");
    }
    const slash = ruleId.lastIndexOf("/");
    const ns = slash < 0 ? "" : ruleId.slice(0, slash);
    return groupOfNamespace.get(ns) ?? LINT_GROUP_BASE;
  };
  // One config per (program, kind, group set), built on first use.
  const configs = new Map<string, Promise<Linter.Config[]>>();
  const programIds = new WeakMap<ts.Program, number>();
  let nextProgram = 0;
  const configFor = (
    program: ts.Program | undefined,
    kind: "syntactic" | "type-aware" | "whole",
    groups: readonly string[],
  ): Promise<Linter.Config[]> => {
    let pid = -1;
    if (program !== undefined) {
      pid = programIds.get(program) ?? nextProgram++;
      programIds.set(program, pid);
    }
    const key = `${pid}\n${kind}\n${groups.join("\n")}`;
    let config = configs.get(key);
    if (config === undefined) {
      config = loadGroups().then(() =>
        kind === "whole"
          ? buildLintConfig({
              root,
              typeSource: { programs: [program!] },
              exemptions: "report",
            })
          : buildLintConfig({
              root,
              typeSource:
                kind === "syntactic"
                  ? { none: true }
                  : { programs: [program!] },
              exemptions: "report",
              rules: {
                base: groups.includes(LINT_GROUP_BASE),
                contributions: new Set(groups),
                kind,
              },
            }),
      );
      configs.set(key, config);
    }
    return config;
  };
  const linter = new Linter({ configType: "flat" });
  const verify = (
    file: string,
    code: string,
    config: Linter.Config[],
  ): RawLintMessage[] =>
    linter
      .verify(code, config, { filename: file })
      // `--quiet` parity: error-level (2) and fatal parse errors only.
      .filter((m) => m.severity === 2 || m.fatal)
      .map((m) => ({
        ruleId: m.ruleId,
        fatal: m.fatal === true,
        line: m.line,
        column: m.column,
        message: m.message,
      }));

  const engine: LintEngine = {
    async typed(program, file, code, unit, groups) {
      if (unit === "whole") {
        if (groups.length !== 1 || groups[0] !== LINT_GROUP_ALL) {
          throw new Error(
            `lint engine: directive file ${file} was sent typed parts ${groups.join(", ")}`,
          );
        }
        return {
          [LINT_GROUP_ALL]: verify(
            file,
            code,
            await configFor(program, "whole", []),
          ),
        };
      }
      const byGroup: Record<string, RawLintMessage[]> = {};
      for (const g of groups) byGroup[g] = [];
      for (const m of verify(
        file,
        code,
        await configFor(program, "type-aware", groups),
      )) {
        // Null-id messages (a parse failure) belong to the syntactic base
        // part: the same text produced them there, run or stored.
        if (m.ruleId === null) continue;
        const bucket = byGroup[groupOf(m.ruleId)];
        if (bucket === undefined) {
          throw new Error(
            `lint engine: ${m.ruleId} reported on ${file} from a typed part that was not run`,
          );
        }
        bucket.push(m);
      }
      return byGroup;
    },
    async syntactic(file, code, groups) {
      const out: Record<string, RawLintMessage[]> = {};
      for (const g of groups) out[g] = [];
      // A message outside the selection can only be a null-id one (a parse
      // failure) on a run without the base group, whose stored result
      // already holds it.
      for (const m of verify(
        file,
        code,
        await configFor(undefined, "syntactic", groups),
      )) {
        out[groupOf(m.ruleId)]?.push(m);
      }
      return out;
    },
    async files(program, specs, read) {
      const out = new Map<string, LintOut>();
      for (const [file, s] of specs) {
        const code = read(file);
        out.set(file, {
          typed:
            s.typed.length > 0
              ? await engine.typed(program, file, code, s.unit, s.typed)
              : {},
          syntactic:
            s.unit === "split" && s.syntactic.length > 0
              ? await engine.syntactic(file, code, s.syntactic)
              : {},
        });
      }
      return out;
    },
  };
  return engine;
}
