/**
 * Regression test for `paths:data-root-not-joined`: the two ways back to a
 * joinable data root must be flagged, and the sanctioned uses of the root must
 * pass through untouched.
 *
 * FLAGGED — `join(dataRoot(), …)`, `resolve(dataRoot(), …)`, the
 * `${dataRoot()}/…` concatenation that is the same join spelled differently, and
 * every READ of the env var by key (`readEnv("DIR")`).
 *
 * NOT FLAGGED — naming the root on its own (`const r = dataRoot()`, which is
 * how a child process is handed one), `relative(dataRoot(), …)` (the
 * `relativeToDataRoot` helper's own body), and every WRITE of the env var:
 * `setEnvDefault`, `setEnv`, and an `envEntries({ DIR })` spread. Those
 * writes ARE the sanctioned handoff — a check that flagged them would be telling
 * the launcher not to launch.
 *
 * The detection routes through `grepCode`, which masks comments and regex
 * literals before re-scanning; `maskStrings:false` keeps template-literal
 * interiors in scope, which is what lets the `${…}` concatenation form be seen
 * at all. `grepCode` shells out to `git grep`, so the test stands up a throwaway
 * repo.
 *
 * As with `no-inlined-worktree-artifacts.test.ts`'s split tokens, the FLAGGED
 * fixture lines are assembled from pieces so the *contiguous* banned pattern
 * never appears in THIS file's own source — otherwise the real check, scanning
 * the repo, would flag these very string literals. (This file is a `.test.ts`
 * and so is exempt anyway; the split keeps it true independently of that, the
 * way the sibling test does.)
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { grepCode } from "@plugins/framework/plugins/tooling/plugins/checks/core";

let root = "";

// Mirror of the check's DATA_ROOT_PATTERNS, verbatim.
const PATTERNS: { pattern: RegExp; grepArg: string }[] = [
  {
    pattern: /(?:join|resolve)\s*\(\s*dataRoot\s*\(\s*\)/,
    grepArg: "dataRoot",
  },
  { pattern: /\$\{\s*dataRoot\s*\(\s*\)\s*\}[/\\]/, grepArg: "dataRoot" },
  {
    pattern: /\breadEnv\s*\(\s*["']DIR["']/,
    grepArg: "readEnv",
  },
];

// Split tokens: assembled into the (contiguous) fixture lines written to the
// temp repo, never spelled contiguously here.
const DR = "dataRoot" + "()";
const ENV = "readEnv(" + '"' + "DIR" + '")';
const BT = "`"; // a literal backtick, kept out of nested-template soup

// ── FLAGGED ────────────────────────────────────────────────────────────────
const L1 = "const a = join(" + DR + ', "whatever");';
const L2 = "const b = resolve(" + DR + ', "whatever");';
// `$` + `{…}` split avoids the no-template-curly-in-string lint; the assembled
// value is an ordinary template literal.
const L3 = "const c = " + BT + "$" + "{" + DR + "}/whatever" + BT + ";";
const L4 = "const d = " + ENV + ";";
const L5 = "if (!" + ENV + ") throw new Error(1);";

// ── NOT FLAGGED ────────────────────────────────────────────────────────────
// Naming the root itself — the sanctioned use.
const N1 = "const r = " + DR + ";";
// The relativeToDataRoot body: `relative` is neither join nor resolve.
const N2 = "const rel = relative(" + DR + ", dir.path);";
// Writes: the handoff to a child process, in all three spellings.
const N3 = 'setEnvDefault("DIR", join(bundleRoot, "data"));';
const N4 = 'setEnv("DIR", dir);';
const N5 = 'const env = { ...envEntries({ DIR: dataDir }), PORT: "1" };';

const FLAGGED = [L1, L2, L3, L4, L5];
const PASSING = [N1, N2, N3, N4, N5];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "data-root-not-joined-test-"));
  writeFileSync(
    join(root, "fixture.ts"),
    [...FLAGGED, ...PASSING].join("\n") + "\n",
  );

  const run = async (...args: string[]) => {
    const proc = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  };
  await run("git", "init", "-q");
  await run("git", "config", "user.email", "t@t.t");
  await run("git", "config", "user.name", "t");
  await run("git", "add", "-A");
  await run("git", "commit", "-q", "-m", "fixture");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("joining the data root and reading its env var are flagged; naming it and writing it are not", async () => {
  const seen = new Set<string>();
  const matches: { line: number; text: string }[] = [];
  for (const p of PATTERNS) {
    const found = await grepCode({
      root,
      pattern: p.pattern,
      grepArg: p.grepArg,
      maskStrings: false,
    });
    for (const m of found) {
      const key = `${m.path}:${m.line}:${m.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ line: m.line, text: m.text });
    }
  }

  const flaggedLines = matches.map((m) => m.line).sort((x, y) => x - y);
  // Exactly the FLAGGED block (lines 1..5) and nothing from PASSING (6..10).
  expect(flaggedLines).toEqual([1, 2, 3, 4, 5]);

  const byLine = new Map(matches.map((m) => [m.line, m.text]));
  for (const [i, text] of FLAGGED.entries()) {
    expect(byLine.get(i + 1)).toBe(text);
  }
});
