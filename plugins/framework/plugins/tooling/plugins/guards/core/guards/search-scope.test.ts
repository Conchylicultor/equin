import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_DIR } from "@plugins/infra/plugins/paths/core";
import { createContext } from "../context";
import type { Verdict } from "../types";
import {
  globScopeGuard,
  grepScopeGuard,
  searchScopeGuard,
} from "./search-scope";

// A real main checkout with a worktree in it: the scope judges real
// directories (a path that is not one walks nothing, and is let through).
const SANDBOX = mkdtempSync(join(tmpdir(), "search-scope-"));
const REPO = join(SANDBOX, "repo");
const WT = join(REPO, ".claude", "worktrees", "att-1-abcd");
mkdirSync(join(WT, "plugins", "a", "b", "c", "d", "e", "f", "g"), {
  recursive: true,
});
mkdirSync(join(REPO, "plugins"), { recursive: true });
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

const DEEP = join(WT, "plugins", "a", "b", "c", "d", "e", "f", "g");
/** From DEEP, enough `..` to climb out of every directory above it. */
const TO_ROOT = "../".repeat(DEEP.split("/").length);

/** The launch names the workspace, so a cwd outside it does not move it. */
const ctx = (cwd: string) =>
  createContext(cwd, "s", [], undefined, null, null, WT);

function verdict(command: string, cwd = WT): Verdict {
  return searchScopeGuard.check({ command }, ctx(cwd)) as Verdict;
}
const blocks = (command: string, cwd = WT) =>
  verdict(command, cwd).kind === "deny";

describe("search-scope guard", () => {
  describe("a walk that escapes the worktree is refused", () => {
    test("the reported command: rg … ../../../../../../../", () => {
      expect(blocks(`rg -n "fs-wait" ${TO_ROOT}`, DEEP)).toBe(true);
    });
    test("the home directory, every spelling", () => {
      expect(blocks(`rg foo ~`)).toBe(true);
      expect(blocks(`rg foo $HOME`)).toBe(true);
      expect(blocks(`rg foo ${HOME_DIR}`)).toBe(true);
    });
    test("cd ~ first, then an implicit-cwd search", () => {
      expect(blocks(`cd ~ && rg foo`)).toBe(true);
      expect(blocks(`cd && fd foo`)).toBe(true);
      expect(blocks(`cd $HOME && fd foo`)).toBe(true);
      expect(blocks(`cd "\${HOME}" && rg foo`)).toBe(true);
    });
    test("rg --files lists the cwd even with a pipe on its stdin", () => {
      expect(blocks(`cd ~ && echo | rg --files`)).toBe(true);
    });
    test("a brace alternative spanning a slash", () => {
      expect(blocks(`rg foo ~/{.claude/projects,Downloads}`)).toBe(true);
    });
    test("a glob is judged by the directory it expands under", () => {
      expect(blocks(`rg foo ~/*`)).toBe(true);
    });
    test("recursive grep, fd, find, du, tree, ls -R, ag", () => {
      expect(blocks(`grep -rn foo ~`)).toBe(true);
      expect(blocks(`grep -R foo ${HOME_DIR}`)).toBe(true);
      expect(blocks(`fd '\\.ts$' ~`)).toBe(true);
      expect(blocks(`fd --search-path ~ foo`)).toBe(true);
      expect(blocks(`find ~ -name '*.jsonl'`)).toBe(true);
      expect(blocks(`du -sh ~`)).toBe(true);
      expect(blocks(`du -d 1 -h ~`)).toBe(true);
      expect(blocks(`tree ~`)).toBe(true);
      expect(blocks(`ls -R ~`)).toBe(true);
      expect(blocks(`ag foo ~`)).toBe(true);
    });
    test("any one of several roots", () => {
      expect(blocks(`rg foo plugins ~`)).toBe(true);
    });
    test("a call later in the command", () => {
      expect(blocks(`rg foo plugins; rg bar ~`)).toBe(true);
      expect(blocks(`echo x | grep -r foo ~`)).toBe(true);
    });
    test("a temp ROOT itself (only one dir below it is bounded)", () => {
      expect(blocks(`rg foo ${tmpdir()}`)).toBe(true);
    });
    test("…while a glob over its entries names one dir below it each", () => {
      expect(blocks(`rg foo ${tmpdir()}/equin-test-*/output.log`)).toBe(false);
    });
  });

  describe("the main checkout", () => {
    test("an ignore-respecting search of it is fine (worktrees are gitignored and hidden)", () => {
      expect(blocks(`rg foo ${REPO}`)).toBe(false);
      expect(blocks(`fd foo ${REPO}`)).toBe(false);
      expect(blocks(`rg foo ${REPO}/plugins`)).toBe(false);
    });
    test("a walk that does not skip ignored dirs is refused at its root", () => {
      expect(blocks(`grep -r foo ${REPO}`)).toBe(true);
      expect(blocks(`rg -uu foo ${REPO}`)).toBe(true);
      expect(blocks(`rg --no-ignore foo ${REPO}/.claude`)).toBe(true);
      expect(blocks(`du -sh ${REPO}`)).toBe(true);
    });
    test("…but not below it", () => {
      expect(blocks(`grep -r foo ${REPO}/plugins`)).toBe(false);
    });
    test("a glob is judged by what it expands to (the shell skips dot entries)", () => {
      expect(blocks(`grep -r foo ${REPO}/*`)).toBe(false);
      expect(blocks(`grep -r foo ${REPO}/.*`)).toBe(true);
      expect(blocks(`grep -r foo ${REPO}/.cl[a]ude`)).toBe(true);
      expect(blocks(`grep -r foo ${REPO}/{plugins,nope}`)).toBe(false);
    });
    test("another agent's checkout is one checkout", () => {
      expect(blocks(`grep -r foo ${REPO}/.claude/worktrees/att-2-x`)).toBe(
        false,
      );
    });
  });

  describe("bounded searches stay allowed", () => {
    test("inside the worktree, however spelled", () => {
      expect(blocks(`rg foo`)).toBe(false);
      expect(blocks(`rg foo plugins`, DEEP)).toBe(false);
      expect(blocks(`rg foo ../..`, DEEP)).toBe(false);
      expect(blocks(`grep -rn foo .`)).toBe(false);
      expect(blocks(`find . -name x`)).toBe(false);
    });
    test("a file is read, not walked", () => {
      expect(blocks(`rg foo ${join(WT, "plugins")}/nope.log`)).toBe(false);
      expect(blocks(`grep foo ~/.zshrc`)).toBe(false);
    });
    test("a path that is not there walks nothing", () => {
      expect(blocks(`rg foo ~/definitely-not-a-dir-9f8e7d`)).toBe(false);
    });
    test("one dir below a shared parent", () => {
      expect(blocks(`rg foo /tmp/some-run`)).toBe(false);
      expect(blocks(`rg foo ${SANDBOX}`, HOME_DIR)).toBe(false);
    });
    test("a pattern is not a root", () => {
      expect(blocks(`rg '~' plugins`)).toBe(false);
      expect(blocks(`rg -e foo -g '/*' plugins`)).toBe(false);
      expect(blocks(`grep -rn -e / plugins`)).toBe(false);
      expect(blocks(`fd '^/' plugins`)).toBe(false);
    });
    test("a search reading its stdin walks nothing", () => {
      expect(blocks(`cat x | rg foo`, HOME_DIR)).toBe(false);
      expect(blocks(`ls | grep -r foo`, HOME_DIR)).toBe(false);
    });
    test("non-recursive grep and ls", () => {
      expect(blocks(`grep foo ~/*`)).toBe(false);
      expect(blocks(`ls ~`)).toBe(false);
    });
    test("an explicit shallow depth is the opt-in", () => {
      expect(blocks(`rg --max-depth 1 foo ~`)).toBe(false);
      expect(blocks(`rg --files --max-depth 2 ~`)).toBe(false);
      expect(blocks(`fd -d 2 . ~`)).toBe(false);
      expect(blocks(`find ~ -maxdepth 1 -name x`)).toBe(false);
      expect(blocks(`tree -L 2 ~`)).toBe(false);
    });
    test("…and a deeper one is not", () => {
      expect(blocks(`rg --max-depth 2 foo ~`)).toBe(true);
      expect(blocks(`fd -d 3 . ~`)).toBe(true);
      expect(blocks(`find ~ -maxdepth 5 -name x`)).toBe(true);
    });
  });

  test("the denial names the root as typed and as resolved", () => {
    const v = verdict(`rg foo ~`);
    expect(v.kind).toBe("deny");
    if (v.kind === "deny")
      expect(v.reason).toContain(`\`~\` → \`${HOME_DIR}\``);
  });
});

describe("Grep / Glob tools", () => {
  const grep = (input: { path?: string; pattern?: string }, cwd = WT) =>
    (grepScopeGuard.check(input, ctx(cwd)) as Verdict).kind;
  const glob = (input: { path?: string; pattern?: string }, cwd = WT) =>
    (globScopeGuard.check(input, ctx(cwd)) as Verdict).kind;

  test("Grep: path is the root, pattern is a regex", () => {
    expect(grep({ pattern: "/x" })).toBe("allow");
    expect(grep({ pattern: "x", path: REPO })).toBe("allow");
    expect(grep({ pattern: "x", path: HOME_DIR })).toBe("deny");
    expect(grep({ pattern: "x" }, HOME_DIR)).toBe("deny");
  });
  test("Glob: an absolute pattern is a root of its own", () => {
    expect(glob({ pattern: "**/*.ts" })).toBe("allow");
    expect(glob({ pattern: `${HOME_DIR}/**/*.jsonl` })).toBe("deny");
    expect(glob({ pattern: "**/*.jsonl", path: HOME_DIR })).toBe("deny");
    // A relative pattern filters the walk of `path`; it is not a root below it.
    expect(glob({ pattern: "CLAUDE.md", path: HOME_DIR })).toBe("deny");
    expect(glob({ pattern: "src/foo.ts", path: HOME_DIR })).toBe("deny");
  });
});
