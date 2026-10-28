import { describe, expect, test } from "bun:test";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";
import { findGuard } from "./find";

function verdict(command: string, cwd = REPO_ROOT): Verdict {
  return findGuard.check({ command }, createContext(cwd)) as Verdict;
}
const rewritten = (command: string) => {
  const v = verdict(command);
  return v.kind === "rewrite" ? v.patch.command : undefined;
};

const PRUNE = `\\( -name node_modules -o -name .git -o -path '*/.claude/worktrees' \\) -prune -o`;

describe("find guard", () => {
  describe("a find inside the workspace is rewritten to prune the heavy dirs", () => {
    for (const [typed, ran] of [
      ["find . -name '*.ts'", `find . ${PRUNE} \\( -name '*.ts' \\) -print`],
      // The implicit -print covers the whole `-o`, so the parens must too.
      [
        "find plugins -name a.ts -o -name b.ts",
        `find plugins ${PRUNE} \\( -name a.ts -o -name b.ts \\) -print`,
      ],
      // An action already present: no -print added.
      [
        "find plugins -name x.ts -exec sed -n 1,5p {} \\;",
        `find plugins ${PRUNE} \\( -name x.ts -exec sed -n 1,5p {} \\; \\)`,
      ],
      ["find plugins", `find plugins ${PRUNE} -print`],
      // Inside a substitution: the call's text is still found exactly once.
      ["f=$(find . -name x)", `f=$(find . ${PRUNE} \\( -name x \\) -print)`],
      [
        "find a b -type f 2>/dev/null | head",
        `find a b ${PRUNE} \\( -type f \\) -print 2>/dev/null | head`,
      ],
      [
        "find a -type f; find b -type d",
        `find a ${PRUNE} \\( -type f \\) -print; find b ${PRUNE} \\( -type d \\) -print`,
      ],
    ]) {
      test(typed!, () => {
        expect(rewritten(typed!)).toBe(ran);
      });
    }

    test("the note shows the command that ran", () => {
      const v = verdict("find . -type f");
      expect(v.kind === "rewrite" && v.note).toContain("-prune");
    });
  });

  describe("denied when a prune would not bound it, or would change it", () => {
    for (const command of [
      "find / -name x",
      "find ~ -name x",
      "find $T -type f",
      "find node_modules -name x",
      "find . -name '*.tmp' -delete",
      "find . -depth -name x",
      "find -d . -name x",
    ]) {
      test(command, () => {
        expect(verdict(command).kind).toBe("deny");
      });
    }
  });

  describe("already bounded → left alone", () => {
    for (const command of [
      "find / -maxdepth 1 -name x",
      "find . -name node_modules -prune -o -print",
      "rg --files",
    ]) {
      test(command, () => {
        expect(verdict(command).kind).toBe("allow");
      });
    }
  });
});
