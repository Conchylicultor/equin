// HOW a file is linted — one copy, shared by the worker (`./worker.ts`) and the
// batch processes (`./batch-worker.ts`): the rule configs per (program, kind,
// group set), the `--quiet` filter, and the grouping of messages by rule group.
// WHICH parts run is decided elsewhere (`./lint-decisions.ts`).
//
// A file with an eslint directive is linted in two steps, so that no rule edit
// needs a program for it beyond the typed parts that edit moved:
//
//   - its RAW typed parts, in the program (`typed`, unit `whole`): the same
//     configs as a split file's typed parts, but every problem of the part's
//     own rules is kept as ESLint found it BEFORE the directives applied —
//     suppressed ones and warnings included (a warning a directive silences
//     makes that directive used). Nothing else: a directive naming a rule
//     this config does not register reports "definition not found" here, and
//     an unused-directive report depends on rules this part does not run;
//   - its VERDICT, with no program (`combined`): every syntactic rule for real
//     and every type-aware rule replayed from the raw parts (the `replayed`
//     type source of the config builder), so ESLint applies the directives to
//     the very problem set one run with a program has — suppression,
//     `eslint-enable` pairing, blanket disables, an unused directive's one
//     message naming its unused rules — by its own code.
//
// Exact because a problem is a function of the text and its own rule (what
// splitting every other file already rests on), and the directives' effect is
// a function of the text and the problems (`apply-disable-directives.js`).

import ts from "typescript";
import { ESLint, Linter } from "eslint";
import {
  buildLintConfig,
  loadLintContributions,
} from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { ReplayedProblem } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { LINT_GROUP_BASE, type RawLintMessage } from "../core";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

/** What to lint of one file: its unit, its stale syntactic groups, its typed groups. */
export interface LintSpec {
  unit: "split" | "whole";
  /** Syntactic groups to run with no program (`split` only). */
  syntactic: string[];
  /** Typed parts to run in the program, by group (`whole`: raw). */
  typed: string[];
}

/** One file's messages, by group. */
export interface LintOut {
  typed: Record<string, RawLintMessage[]>;
  syntactic: Record<string, RawLintMessage[]>;
}

export interface LintEngine {
  /**
   * A file's typed parts, inside `program` (which holds it as source) — for a
   * `whole` (directive) file, raw: its rules' problems before its directives.
   */
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
  /**
   * A directive file's verdict, with no program: every syntactic rule, and
   * every type-aware rule replayed from `raw` (its raw typed parts' messages,
   * all of them), the directives applied by ESLint. `--quiet` filtered.
   */
  combined(
    file: string,
    code: string,
    raw: readonly RawLintMessage[],
  ): Promise<RawLintMessage[]>;
  /** Both, for every file of `specs` (absolute path → spec). */
  files(
    program: ts.Program,
    specs: ReadonlyMap<string, LintSpec>,
    read: (file: string) => string,
  ): Promise<Map<string, LintOut>>;
}

/** Whether a resolved rule entry is off (`0` / `"off"`, alone or with options). */
function isOff(entry: Linter.RuleEntry): boolean {
  const severity = Array.isArray(entry) ? entry[0] : entry;
  return severity === 0 || severity === "off";
}

/**
 * `declaredUtilities` is the stylesheet's `@utility` set every config is built
 * with — what `lintDataKey` keyed the run's results on — read by the caller
 * (`readDeclaredUtilities`) and handed in as data: this module is lint engine
 * by its import closure (`check/lint-groups.ts` roots the engine at every
 * module importing ESLint), so it reads no file, and the file reader stays out
 * of every lint key.
 */
export function createLintEngine(
  root: AppPath,
  declaredUtilities: ReadonlySet<string>,
): LintEngine {
  // A rule id's namespace is its contribution's `name`; anything else (the
  // config builder's own typescript-eslint / react-hooks / core rules) and a
  // null id (the linter itself: a parse failure) belong to the base group.
  // Loaded on the first file that lints: a run with nothing to lint (most)
  // never pays for the rules.
  let groupOfNamespace: Map<string, string> | undefined;
  const loadGroups = async (): Promise<void> => {
    groupOfNamespace ??= new Map(
      (await loadLintContributions(declaredUtilities)).map(
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
  // What the replayed type-aware rules of the combined config report: the
  // file being verified's raw typed problems, by rule id. Set around each
  // synchronous `verify`, so one config serves every file.
  let replaying: ReadonlyMap<string, ReplayedProblem[]> | undefined;
  const answers = (ruleId: string): readonly ReplayedProblem[] => {
    if (replaying === undefined) {
      throw new Error(
        `lint engine: the replayed rule ${ruleId} ran outside a combined lint`,
      );
    }
    return replaying.get(ruleId) ?? [];
  };
  // One config per (program, kind, group set), built on first use.
  const configs = new Map<string, Promise<Linter.Config[]>>();
  const programIds = new WeakMap<ts.Program, number>();
  let nextProgram = 0;
  const configFor = (
    program: ts.Program | undefined,
    kind: "syntactic" | "type-aware" | "combined",
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
        kind === "combined"
          ? buildLintConfig({
              root,
              typeSource: { replayed: { answers } },
              exemptions: { mode: "report" },
              declaredUtilities,
            })
          : buildLintConfig({
              root,
              typeSource:
                kind === "syntactic"
                  ? { none: true }
                  : { programs: [program!] },
              exemptions: { mode: "report" },
              declaredUtilities,
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
  // Whether any rule of a syntactic config is on for a file — read off the
  // config alone (the file's scope blocks: test/e2e files, a rule's
  // `outOfScope` categories), with no parse. ESLint parses a file even when
  // every rule is off for it, and the parse is the whole cost of a syntactic
  // lint (TS scan, ESTree conversion, tokens, scope analysis; the rules
  // themselves are ~free), so one rule's edit re-parsed the ~20% of the tree
  // its scope excludes, to answer nothing. `ESLint` here only resolves
  // configs: it lints nothing, and holds the config normalized once.
  const resolvers = new WeakMap<Linter.Config[], ESLint>();
  const anyRuleOn = async (
    file: string,
    config: Linter.Config[],
  ): Promise<boolean> => {
    let resolver = resolvers.get(config);
    if (resolver === undefined) {
      resolver = new ESLint({
        cwd: process.cwd(),
        overrideConfigFile: true,
        overrideConfig: config,
      });
      resolvers.set(config, resolver);
    }
    const resolved = (await resolver.calculateConfigForFile(file)) as
      Linter.Config | undefined;
    // An ignored file: verify decides, as it always has.
    if (resolved === undefined) return true;
    return Object.values(resolved.rules ?? {}).some(
      (entry) => entry !== undefined && !isOff(entry),
    );
  };
  const raw = (m: Linter.LintMessage): RawLintMessage => ({
    ruleId: m.ruleId,
    fatal: m.fatal === true,
    line: m.line,
    column: m.column,
    message: m.message,
  });
  const verify = (
    file: string,
    code: string,
    config: Linter.Config[],
  ): RawLintMessage[] =>
    linter
      .verify(code, config, { filename: file })
      // `--quiet` parity: error-level (2) and fatal parse errors only.
      .filter((m) => m.severity === 2 || m.fatal)
      .map(raw);
  /** The rule ids a config configures — the only ones whose problems it owns. */
  const configured = new WeakMap<Linter.Config[], ReadonlySet<string>>();
  const configuredOf = (config: Linter.Config[]): ReadonlySet<string> => {
    let ids = configured.get(config);
    if (ids === undefined) {
      ids = new Set(config.flatMap((c) => Object.keys(c.rules ?? {})));
      configured.set(config, ids);
    }
    return ids;
  };
  /**
   * Every problem of `config`'s own rules, before the directives applied:
   * what `verify` kept plus what a directive suppressed, any severity. Not a
   * null-id message (a parse failure, a directive report — the combined run
   * makes its own) nor another rule's (a directive naming a rule this config
   * does not register is "not found" here, and only here).
   */
  const verifyRaw = (
    file: string,
    code: string,
    config: Linter.Config[],
  ): RawLintMessage[] => {
    const own = configuredOf(config);
    return [
      ...linter.verify(code, config, { filename: file }),
      ...linter.getSuppressedMessages(),
    ]
      .filter((m) => m.ruleId !== null && own.has(m.ruleId))
      .map(raw);
  };

  const engine: LintEngine = {
    async typed(program, file, code, unit, groups) {
      const byGroup: Record<string, RawLintMessage[]> = {};
      for (const g of groups) byGroup[g] = [];
      const config = await configFor(program, "type-aware", groups);
      for (const m of unit === "whole"
        ? verifyRaw(file, code, config)
        : verify(file, code, config)) {
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
      const config = await configFor(undefined, "syntactic", groups);
      // Every selected rule off for this file: its answer is no message,
      // known without parsing it. Exact for a split file (the only kind
      // linted here): it has no directive and no inline rule config
      // (`hasLintDirective` sends such a file whole), so nothing but the
      // config decides which rules run, and no unused-directive report can
      // arise. Not with the base group: its parse failure (a null-id
      // message) is the base part's answer, and only a parse finds it.
      if (
        !groups.includes(LINT_GROUP_BASE) &&
        !(await anyRuleOn(file, config))
      ) {
        return out;
      }
      // A message outside the selection can only be a null-id one (a parse
      // failure) on a run without the base group, whose stored result
      // already holds it.
      for (const m of verify(file, code, config)) {
        out[groupOf(m.ruleId)]?.push(m);
      }
      return out;
    },
    async combined(file, code, rawMessages) {
      const config = await configFor(undefined, "combined", []);
      const byRule = new Map<string, ReplayedProblem[]>();
      for (const m of rawMessages) {
        if (m.ruleId === null) {
          throw new Error(
            `lint engine: ${file}'s raw typed parts hold a message with no rule: ${m.message}`,
          );
        }
        let list = byRule.get(m.ruleId);
        if (list === undefined) byRule.set(m.ruleId, (list = []));
        list.push({ line: m.line, column: m.column, message: m.message });
      }
      replaying = byRule;
      let out: RawLintMessage[];
      try {
        out = verify(file, code, config);
      } finally {
        replaying = undefined;
      }
      // An inline rule config (`/* eslint <rule>: … */`) changes which rules
      // run per file, and so which part's rules a problem belongs to: a typed
      // rule it switches on runs in a part that does not own it, and its own
      // "invalid inline config" problem lands in a raw part and here alike.
      // No repo file has one; the split cannot answer one exactly, so it is
      // refused rather than given a verdict a whole run would not.
      // ESLint reads one only from a block comment labelled exactly `eslint`.
      const inline = linter
        .getSourceCode()
        .getAllComments()
        .find((c) => c.type === "Block" && /^\s*eslint(?:\s|$)/.test(c.value));
      if (inline !== undefined) {
        throw new Error(
          `lint engine: ${file}:${inline.loc?.start.line ?? "?"} configures a rule inline (\`/*${inline.value}*/\`) — the type-check lint store cannot split such a file's rules; use a disable directive, or the rule's own scope (\`lint/index.ts\`) or an exemption (\`exempt/index.ts\`)`,
        );
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
