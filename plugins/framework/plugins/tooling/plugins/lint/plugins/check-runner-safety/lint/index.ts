import noAdhocCheckRunner from "./no-adhoc-check-runner";

export default {
  name: "check-runner-safety",
  rules: {
    "no-adhoc-check-runner": noAdhocCheckRunner,
  },
  /**
   * No test exemption — unlike `sink-safety`,
   * whose rules are out of scope in tests.
   *
   * Contributed rules are off in test/e2e files by default (NON_APP_FILE_GLOBS)
   * because they enforce the app's *composition*, which a suite observes from
   * outside. This rule is not that: it guards a durable, cross-process side
   * effect. A `*.test.ts` that drives `runChecks()` runs in a process that
   * imported whatever the suite imported, and it writes PASS entries into the
   * SAME global cache (`~/.equin/check-cache/`) that a later `push` reads
   * and trusts without re-running anything. A test harness is INSIDE this blast
   * radius, not outside it — so the rule is opted back in everywhere via
   * `enforceEverywhere`, the same way `promise-safety` keeps its bug-catching
   * rules on in tests.
   *
   * The sanctioned owner (`cli/plugins/check/cli/run.ts`) is matched in-rule by
   * filename, so it needs no entry here either.
   *
   * This file's own RuleTester fixtures embed the banned specifier in JS
   * strings, so the rule does not self-flag its tests.
   */
  enforceEverywhere: ["no-adhoc-check-runner"],
};
