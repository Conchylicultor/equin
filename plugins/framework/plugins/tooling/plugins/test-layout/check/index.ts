import { existsSync } from "@plugins/packages/plugins/timed-fs/core";
import { join } from "node:path";
import type {
  Check,
  CheckContext,
  CheckResult,
  RepoFiles,
} from "@plugins/framework/plugins/tooling/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { createTimeSlicer } from "@plugins/packages/plugins/macrotask-yield/core";
import {
  findImports,
  lineAt,
  maskSource,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import { fakeDomInstalls } from "../core/fake-dom";
import {
  BUN_TEST_IGNORE,
  DOM_TEST_CLOCK_PIN,
  DOM_TEST_INCLUDE,
  DOM_TEST_LC_ALL,
  DOM_TEST_POOL,
  DOM_TEST_SETUP_FILE,
  DOM_TEST_TIME_ZONE,
  isBunTestPath,
  isDomTestPath,
} from "../core/test-layout";

const BUNFIG = "bunfig.toml";
const VITEST_CONFIG = "vitest.config.ts";

/**
 * The runner split, enforced.
 *
 * The repo runs two test runners and picks between them BY FILE LOCATION. That
 * only holds if the two scopes stay exact complements and no test file imports
 * the other runner's API. Nothing enforced it, and it was false: `bunfig.toml`
 * scoped `bun test` to nothing, so `bun test <plugin-dir>` loaded the
 * vitest-only jsdom suites and produced a wall of failures indistinguishable
 * from real ones.
 *
 * Seven rules, every offender reported:
 *   (a) no bun:test file imports `vitest`      — the direct guard on that bug
 *   (b) no vitest file imports `bun:test`      — the mirror direction
 *   (c) no test file sits under a `__tests__/` dir that is not
 *       `plugins/**\/web/__tests__/` — either it is in NEITHER runner's scope
 *       (silently never run) or it is a bun:test suite wearing vitest's
 *       directory convention
 *   (d) both scope literals are still present in their config files — this is
 *       what makes the fix structural instead of deletable
 *   (e) no bun:test file builds itself a fake DOM — see {@link FAKE_DOM_GLOBALS}
 *   (f) the shared vitest setup file still pins the clock — same spirit as (d):
 *       a jsdom test must not be able to depend on what day it runs on, and the
 *       pin is a few lines in a file otherwise full of DOM stubs, easy to delete
 *       while chasing something else. The bill arrives much later, as a suite
 *       that goes red for everyone on a date nobody edited.
 *   (g) the vitest config still pins the workers' locale and timezone — the
 *       clock's twin, living in the config rather than the setup file because
 *       a process's default locale is fixed when it starts. Without it a suite
 *       passes on a laptop and fails under `LANG=C.UTF-8` with no code change.
 *
 * NOT `inputKeyed`: unlike the `grepCode`-only pattern checks, this one
 * reads `bunfig.toml` / `vitest.config.ts` directly, so its reads do NOT route through the recording
 * `FileSystemView`. Declaring it input-keyed would record an incomplete
 * read-set and could produce a stale PASS. It takes the legacy whole-tree key.
 */
const check: Check = {
  id: "test-layout:runner-split",
  description:
    "bun:test and vitest scopes stay exact complements: no test file imports the other runner, no stray `__tests__/` suite, both scope literals survive in bunfig.toml / vitest.config.ts, the shared vitest setup still pins the clock, and vitest.config.ts still pins the workers' locale and timezone",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const root = REPO_ROOT;
    const repo = await ctx.repo();
    const sections: string[] = [];

    // ---- rules (a)–(c): the test-file sweep --------------------------------
    const listed = listTestFiles(repo);

    const crossVitest: string[] = [];
    const crossBunTest: string[] = [];
    const fakeDom: string[] = [];

    // Read concurrently, then scan serially. Each scan is synchronous parsing;
    // run inside the reads' callbacks, the scans of reads that settle together
    // chained into one block on the check runner's shared thread. The slicer
    // yields between files instead.
    const read = await Promise.all(listed.map((rel) => repo.read(rel)));
    // A null read: removed since the set was taken — no file, no offense.
    const files = listed.filter((_, i) => read[i] != null);
    const sources = read.filter((src): src is string => src != null);
    const slice = createTimeSlicer();
    for (let f = 0; f < files.length; f++) {
      await slice();
      const rel = files[f]!;
      const src = sources[f]!;
      const dom = isDomTestPath(rel);

      // (e) A bun:test file installing a browser global onto `globalThis`.
      if (isBunTestPath(rel)) {
        for (const install of fakeDomInstalls(src)) {
          fakeDom.push(
            `${rel}:${lineAt(src, install.index)}  (installs \`${install.name}\`)`,
          );
        }
      }

      // A test file's runner is decided by WHERE it lives, so the banned
      // specifier is whichever runner does not own this location.
      const banned = dom ? "bun:test" : "vitest";
      const lines = src.split("\n");
      for (const ref of runnerImports(src)) {
        if (ref.specifier !== banned && !ref.specifier.startsWith(`${banned}/`))
          continue;
        const line = lineAt(src, ref.index);
        const entry = `${rel}:${line}:${(lines[line - 1] ?? "").trim()}`;
        if (dom) crossBunTest.push(entry);
        else crossVitest.push(entry);
      }
    }

    if (crossVitest.length > 0) {
      sections.push(
        `(a) ${crossVitest.length} bun:test file(s) import \`vitest\` — bun:test runs these and cannot resolve it:\n    ${crossVitest.sort().join("\n    ")}`,
      );
    }
    if (crossBunTest.length > 0) {
      sections.push(
        `(b) ${crossBunTest.length} vitest file(s) under \`web/__tests__/\` import \`bun:test\` — vitest runs these and cannot resolve it:\n    ${crossBunTest.sort().join("\n    ")}`,
      );
    }

    // (c) Any `__tests__/` dir other than `plugins/**/web/__tests__/`. Two
    // flavours, both wrong, distinguished in the report because the fix differs:
    // an orphan runs under NO runner; a misplaced suite runs under bun:test
    // while claiming vitest's directory convention.
    const strays = files
      .filter(
        (rel) => !isDomTestPath(rel) && rel.split("/").includes("__tests__"),
      )
      .map(
        (rel) =>
          `${rel}  (${isBunTestPath(rel) ? "bun:test suite wearing vitest's `__tests__/` convention" : "in NEITHER runner's scope — never runs"})`,
      );
    if (strays.length > 0) {
      sections.push(
        `(c) ${strays.length} test file(s) under a \`__tests__/\` dir that is not \`plugins/**/web/__tests__/\`:\n    ${strays.sort().join("\n    ")}`,
      );
    }

    if (fakeDom.length > 0) {
      sections.push(
        `(e) ${fakeDom.length} bun:test file(s) install a browser global on \`globalThis\` — bun:test has no DOM, and a hand-built one is a PARTIAL one:\n    ${fakeDom.sort().join("\n    ")}`,
      );
    }

    // ---- rule (d): the two scope literals ---------------------------------
    // A substring assert, not a parse: the point is that the exact string a
    // human would delete is still there.
    const scopeDrift = await checkScopeLiterals(root);
    if (scopeDrift !== null) sections.push(scopeDrift);

    // ---- rule (f): the pinned jsdom clock ---------------------------------
    const clockDrift = await checkClockPin(root);
    if (clockDrift !== null) sections.push(clockDrift);

    // ---- rule (g): the pinned jsdom locale and timezone -------------------
    const localeDrift = await checkLocalePin(root);
    if (localeDrift !== null) sections.push(localeDrift);

    if (sections.length === 0) return { ok: true };

    return {
      ok: false,
      message: `test-runner layout violations:\n  ${sections.join("\n  ")}`,
      hint: `The runner is chosen by where the file lives: pure-logic tests are \`*.test.ts(x)\` next to their source and run under \`bun:test\`; jsdom/React tests live in the plugin's \`web/__tests__/\` and run under vitest. Move the file to the folder that matches its runner rather than swapping the import (or stubbing the DOM it lacks) — and never introduce a \`__tests__/\` dir outside \`web/\`. The two scope literals in \`bunfig.toml\` and \`vitest.config.ts\` are a complementary pair; edit neither alone. And \`${DOM_TEST_SETUP_FILE}\` must keep pinning the clock: every jsdom suite starts on a fixed instant so none of them can depend on the day it is run on — a suite that reads the wall clock is green until the calendar moves, then red for everyone with no code change. Change the pinned instant if you must, but keep the pin. Likewise \`${VITEST_CONFIG}\` must keep starting its workers in a fixed locale and timezone (\`pool\` + \`env\`), or a date-formatting suite passes or fails according to the \`LANG\` of whoever runs it.`,
    };
  },
};

/**
 * Every test file in the checkout, repo-relative: the run's file set (tracked +
 * not-yet-committed, never gitignored, minus files deleted in the working
 * tree), so a brand-new offender is visible while `node_modules` and nested
 * worktrees are not. The git pathspecs `*.test.ts` / `*.test.tsx` (`*` spans
 * `/`), matched exactly.
 */
function listTestFiles(repo: RepoFiles): string[] {
  return [...repo.glob("*.test.ts"), ...repo.glob("*.test.tsx")]
    .filter((rel) => rel.endsWith(".test.ts") || rel.endsWith(".test.tsx"))
    .sort();
}

interface RunnerImport {
  specifier: string;
  /** Offset of the specifier's first character in the ORIGINAL source. */
  index: number;
}

/**
 * Every module specifier the file imports, static or dynamic: `findImports`
 * with its `import("…")`s — string-masked, so a specifier inside a comment or
 * a docs snippet cannot match.
 */
function runnerImports(src: string): RunnerImport[] {
  return findImports(src, undefined, { dynamic: true }).map((imp) => ({
    specifier: imp.specifier,
    index: imp.index,
  }));
}

/**
 * Rule (d). Each half names the OTHER file: the two literals are a
 * complementary pair, and removing one alone is precisely what reintroduces the
 * cross-load — so the message has to point at the half that is still standing.
 */
async function checkScopeLiterals(root: string): Promise<string | null> {
  const bunfigPath = join(root, BUNFIG);
  const vitestPath = join(root, VITEST_CONFIG);

  if (!existsSync(bunfigPath)) {
    return `(d) \`${BUNFIG}\` is missing — it must carry \`pathIgnorePatterns = ["${BUN_TEST_IGNORE}"]\`, the exact complement of the \`include\` in \`${VITEST_CONFIG}\`.`;
  }
  if (!existsSync(vitestPath)) {
    return `(d) \`${VITEST_CONFIG}\` is missing — it must carry \`include: ["${DOM_TEST_INCLUDE}"]\`, the exact complement of \`pathIgnorePatterns\` in \`${BUNFIG}\`.`;
  }

  // Comments are stripped FIRST. Both files explain the pair in a comment that
  // quotes the very literal being asserted, so a whole-file substring test would
  // still pass after the live directive was deleted — the check would guard the
  // prose and not the setting. `maskSource` blanks JS/TS comments (strings kept
  // intact, which is where the literal lives); TOML gets the same treatment from
  // the small stripper below.
  const bunfig = stripTomlComments(await Bun.file(bunfigPath).text());
  const vitestConfig = maskSource(await Bun.file(vitestPath).text(), {
    strings: false,
  });

  const bunfigOk = bunfig.includes(BUN_TEST_IGNORE);
  const vitestOk = vitestConfig.includes(DOM_TEST_INCLUDE);
  if (bunfigOk && vitestOk) return null;

  if (!bunfigOk && !vitestOk) {
    return `(d) BOTH scope literals are gone: \`${BUNFIG}\` no longer contains \`${BUN_TEST_IGNORE}\` and \`${VITEST_CONFIG}\` no longer contains \`${DOM_TEST_INCLUDE}\`. Neither runner is scoped, so both load every test file.`;
  }
  if (!bunfigOk) {
    return `(d) \`${BUNFIG}\` no longer contains the bun:test ignore \`${BUN_TEST_IGNORE}\`, but \`${VITEST_CONFIG}\` still scopes vitest to \`${DOM_TEST_INCLUDE}\`. That asymmetry IS the bug: with only the vitest half in place, \`bun test <plugin-dir>\` re-loads the jsdom suites it must never run.`;
  }
  return `(d) \`${VITEST_CONFIG}\` no longer contains the include \`${DOM_TEST_INCLUDE}\`, but \`${BUNFIG}\` still ignores \`${BUN_TEST_IGNORE}\`. With only the bun:test half in place, the \`web/__tests__/\` suites are excluded from bun:test and no longer claimed by vitest — they run under no runner at all.`;
}

/**
 * Rule (f). The same substring assert as (d), for the same reason: the point is
 * that the exact string a human would delete is still there, not that the file
 * parses to something equivalent.
 *
 * Comments are stripped first — the setup file explains the pin at length, and
 * that prose quotes the call — so this guards the live statement and not the
 * paragraph about it. The setup file lives outside `plugins/`, hence a plain
 * repo-relative read.
 */
async function checkClockPin(root: string): Promise<string | null> {
  const setupPath = join(root, DOM_TEST_SETUP_FILE);
  if (!existsSync(setupPath)) {
    return `(f) \`${DOM_TEST_SETUP_FILE}\` is missing — it is the shared vitest setup named by \`setupFiles\` in \`${VITEST_CONFIG}\`, and the one place the jsdom clock is pinned.`;
  }

  const setup = maskSource(await Bun.file(setupPath).text(), {
    strings: false,
  });
  if (setup.includes(DOM_TEST_CLOCK_PIN)) return null;

  return `(f) \`${DOM_TEST_SETUP_FILE}\` no longer pins the clock — \`${DOM_TEST_CLOCK_PIN}\` is gone. Every jsdom suite now reads the ambient wall clock again, so a test may quietly depend on the day it runs on: green today, red on some later date, for everyone, with no code change to point at.`;
}

/**
 * Rule (g). The same comment-stripped substring assert as (d) and (f), over the
 * three directives that together pin a worker's locale and timezone: the env
 * values themselves, and the process pool that makes `test.env` a worker's
 * STARTUP environment. Any one missing and the pin is gone — `threads` keeps the
 * env lines but they no longer reach ICU.
 */
async function checkLocalePin(root: string): Promise<string | null> {
  const vitestPath = join(root, VITEST_CONFIG);
  // A missing config is already rule (d)'s report.
  if (!existsSync(vitestPath)) return null;

  const vitestConfig = maskSource(await Bun.file(vitestPath).text(), {
    strings: false,
  });
  const missing = [
    `pool: "${DOM_TEST_POOL}"`,
    `LC_ALL: "${DOM_TEST_LC_ALL}"`,
    `TZ: "${DOM_TEST_TIME_ZONE}"`,
  ].filter((directive) => !vitestConfig.includes(directive));
  if (missing.length === 0) return null;

  return `(g) \`${VITEST_CONFIG}\` no longer pins the jsdom workers' locale and timezone — missing ${missing.map((d) => `\`${d}\``).join(", ")}. A worker then starts in the runner's own locale, so a suite that formats a date passes on a laptop and fails under \`LANG=C.UTF-8\` (agent sessions, CI) with no code change. The pin has to be in the config: a process's default locale is fixed when it starts, so \`${DOM_TEST_SETUP_FILE}\` is too late to set it (it only asserts it).`;
}

/**
 * Blank `#`-to-end-of-line TOML comments, leaving quoted strings intact — the
 * TOML twin of `maskSource`'s comment handling, so the rule-(d) assert sees the
 * live directives only. A `#` inside a quoted value is not a comment.
 */
function stripTomlComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i]!;
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === "#") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

export default check;
