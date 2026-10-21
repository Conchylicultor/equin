import { describe, expect, test } from "bun:test";
import { assertShellOutputPath } from "./output-path";

const ctx = { roots: ["/tmp", "/private/tmp"], uid: 501 };
const SHELL = "ba33n0xov";
const GOOD = `/private/tmp/claude-501/-Users-me-repo/9f171ddd-8ac5-4829-b57f-7b5269196555/tasks/${SHELL}.output`;

describe("assertShellOutputPath", () => {
  test("accepts Claude Code's own layout, under either tmp spelling", () => {
    expect(() => assertShellOutputPath(GOOD, SHELL, ctx)).not.toThrow();
    expect(() =>
      assertShellOutputPath(GOOD.replace("/private/tmp", "/tmp"), SHELL, ctx),
    ).not.toThrow();
  });

  const forged: [string, string, string][] = [
    ["a file outside tmp", "/etc/passwd", SHELL],
    [
      "another user's claude dir",
      GOOD.replace("claude-501", "claude-0"),
      SHELL,
    ],
    ["another shell's output", GOOD, "zzz"],
    [
      "a traversal segment",
      `/tmp/claude-501/../x/tasks/${SHELL}.output`,
      SHELL,
    ],
    ["a deeper path", `/tmp/claude-501/a/b/c/tasks/${SHELL}.output`, SHELL],
    ["a shallower path", `/tmp/claude-501/a/tasks/${SHELL}.output`, SHELL],
    ["a non-tasks dir", `/tmp/claude-501/a/b/other/${SHELL}.output`, SHELL],
    [
      "a root prefix that is not a dir boundary",
      `/tmpx/claude-501/a/b/tasks/${SHELL}.output`,
      SHELL,
    ],
    ["a malformed shell id", `/tmp/claude-501/a/b/tasks/..output`, "."],
  ];
  for (const [why, path, shellId] of forged) {
    test(`refuses ${why}`, () => {
      expect(() => assertShellOutputPath(path, shellId, ctx)).toThrow(
        /background-shells/,
      );
    });
  }
});
