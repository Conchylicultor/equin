import {
  grepCode,
  listCandidateSources,
} from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";

/**
 * One spelling for invoking Playwright, enforced: `bun run playwright …`, never
 * `bunx playwright …` or `npx playwright …`.
 *
 * A package runner resolves the tool INDEPENDENTLY of the workspace: when the
 * package is not already installed where it looks, it fetches registry `latest`
 * — it reads neither `package.json`'s range nor `bun.lock`. Run that way,
 * `playwright install` provisions the chromium revision of whatever version it
 * happened to fetch, and registers a `.links` entry that pins that revision
 * against Playwright's own stale-browser GC. That is not hypothetical: one such
 * invocation left ~1 GB of orphaned chromium revisions in the shared cache on
 * this machine, and a revision the repo never chose is exactly what makes
 * `chromium.launch()` fail with an executable path nothing provisioned.
 *
 * `bun run playwright …` resolves the `playwright` script from the root
 * `package.json`, which resolves the workspace's own installed binary — the same
 * one every launch site loads.
 *
 * ## WHAT COUNTS AS AN OCCURRENCE — the split, and why
 *
 * The harm is a COMMAND SOMEONE RUNS, not a sentence about one. So the scan is
 * two passes with different rules, mirroring `paths:no-hardcoded-paths`:
 *
 *   - **TypeScript** goes through `grepCode` with `maskStrings: false`, which
 *     masks comments and regex literals but NOT strings. A message string is
 *     the thing an operator copies out of an error and pastes into a shell, so
 *     it counts. A comment is prose, so it does not — which is why this very
 *     docblock can name the banned spellings in full. It could not before, and
 *     the tax showed: the first person to explain the rule in a comment had to
 *     contort the sentence to get past the check.
 *
 *   - **Everything else** — markdown, JSON, TOML, shell — is scanned raw, and
 *     `research/` is excluded from both passes (historical record; rewriting it
 *     would erase the evidence for the rule). Raw because none of those formats
 *     has a comment syntax to mask, so there is no honest line to draw inside
 *     them, and because a doc is read by agents who then run what it shows.
 *     **Consequence, deliberate:** prose in a `.md` must DESCRIBE the banned
 *     spelling rather than write it. That is a real constraint on doc authors,
 *     and it is the price of covering the `CLAUDE.md` remediation strings that
 *     were half of what made this rule necessary.
 *
 * The pattern below is composed from `RUNNERS` and `TOOL` rather than written
 * out, so this file's own STRING literals — which the source pass does not mask
 * — never contain the adjacency. The check therefore cannot flag itself under
 * either pass, with no allowlist entry. An allowlist is a hole, and this check
 * having one would be the first thing copied.
 */

/** The package runners that resolve outside the workspace. */
const RUNNERS = ["bunx", "npx"] as const;

/** The tool whose version pins an out-of-band binary, so the spelling matters. */
const TOOL = "playwright";

/** The spelling that resolves the workspace's own install. */
const CORRECT = `bun run ${TOOL} …`;

/** Composed, never written out — see the docblock's last paragraph. */
const OFFENDING = new RegExp(
  String.raw`\b(?:${RUNNERS.join("|")})\s+${TOOL}\b`,
);

/** Same shape, in POSIX ERE, for the `git grep -l` candidate pre-filter. */
const GREP_ARG = `(${RUNNERS.join("|")})[[:space:]]+${TOOL}`;

/** Comments are masked here; strings are not. */
const SOURCE_PATHSPECS = ["*.ts", "*.tsx", ":(exclude)research/"];

/**
 * Everything the source pass does not cover, scanned raw. Expressed as
 * "everything minus TypeScript" rather than as a list of extensions, so a
 * format nobody thought of (a CI yaml, a shell script) is covered the day it
 * appears instead of being a hole nobody notices.
 */
const RAW_PATHSPECS = [
  ".",
  ":(exclude)research/",
  ":(exclude)*.ts",
  ":(exclude)*.tsx",
];

interface Offender {
  rel: string;
  line: number;
  text: string;
}

const check: Check = {
  id: "e2e-harness:pinned-playwright-invocation",
  description: `Playwright is invoked as \`${CORRECT}\`, never through a package runner that can resolve a version the lockfile never chose`,
  async run(): Promise<CheckResult> {
    const root = await getWorktreeRoot();
    const offenders: Offender[] = [];

    for (const m of await grepCode({
      root,
      pattern: OFFENDING,
      grepArg: GREP_ARG,
      maskStrings: false,
      pathspecs: SOURCE_PATHSPECS,
    })) {
      offenders.push({ rel: m.path, line: m.line, text: m.text.trim() });
    }

    for (const { rel, src } of await listCandidateSources({
      root,
      grepArg: GREP_ARG,
      pathspecs: RAW_PATHSPECS,
    })) {
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i] ?? "";
        if (OFFENDING.test(text)) {
          offenders.push({ rel, line: i + 1, text: text.trim() });
        }
      }
    }

    if (offenders.length === 0) return { ok: true };

    const listed = offenders
      .map((o) => `${o.rel}:${o.line}  ${o.text}`)
      .join("\n    ");
    return {
      ok: false,
      message: `${offenders.length} package-runner Playwright invocation(s):\n    ${listed}`,
      hint:
        `Rewrite each as \`${CORRECT}\`. ` +
        `A package runner resolves ${TOOL} outside the workspace and falls back to registry \`latest\`, ` +
        `so it can provision (and pin against Playwright's GC) a chromium revision no launch site here ever loads. ` +
        `\`bun run\` resolves the root package.json's \`${TOOL}\` script, i.e. this checkout's own installed binary. ` +
        `To RUN a repo script rather than the tool, use \`./equin run <script.ts>\`. ` +
        `A TypeScript COMMENT explaining the rule is exempt (comments are masked); a string, or any line in a doc, is not.`,
    };
  },
};

export default check;
