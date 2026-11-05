/**
 * Tests for the `no-adhoc-repo-listing` lint rule. Run with `./equin test`.
 *
 * The rule bans listing the working tree outside a pass root: a call to one of
 * the file-set loaders, or an argv that runs `git ls-files`.
 */

import rule from "./no-adhoc-repo-listing";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-adhoc-repo-listing", rule, {
  valid: [
    // Reading the caller's set.
    {
      code: `const files = (await ctx.repo()).glob("plugins/**/package.json");`,
    },
    { code: `function f(repo) { return repo.under("config"); }` },
    // Other git subcommands.
    { code: `spawnCaptured(["git", "rev-parse", "HEAD"], { cwd });` },
    { code: `git(root, ["diff-files", "--name-only"]);` },
    // "ls-files" as data, not as the subcommand of an argv.
    { code: `const READ_VERBS = new Set(["status", "ls-files", "log"]);` },
    { code: `const doc = "git ls-files lists the index";` },
  ],
  invalid: [
    {
      code: `const repo = await loadRepoFiles(root);`,
      errors: [{ messageId: "adhocListing" }],
    },
    {
      code: `const snap = await loadRepoSnapshot(root);`,
      errors: [{ messageId: "adhocListing" }],
    },
    {
      code: `const files = await checks.listRepoFiles(root);`,
      errors: [{ messageId: "adhocListing" }],
    },
    {
      // A spawn's argv.
      code: `await spawnCaptured(["git", "ls-files", "*tsconfig*.json"], { cwd: root });`,
      errors: [{ messageId: "adhocListing" }],
    },
    {
      // A global flag before the subcommand.
      code: `Bun.spawnSync(["git", "-C", root, "ls-files", "-z"]);`,
      errors: [{ messageId: "adhocListing" }],
    },
    {
      // The git binary as a constant.
      code: `await spawnCaptured([GIT, "--no-optional-locks", "-C", wtPath, "ls-files", "--others"], {});`,
      errors: [{ messageId: "adhocListing" }],
    },
    {
      // A git helper's argv led by a global flag.
      code: `await runGit(["--literal-pathspecs", "ls-files", "-z", "--others"], cwd);`,
      errors: [{ messageId: "adhocListing" }],
    },
    {
      // Handed to a git helper.
      code: `await git(root, ["ls-files", "--others", "--exclude-standard"]);`,
      errors: [{ messageId: "adhocListing" }],
    },
  ],
});
