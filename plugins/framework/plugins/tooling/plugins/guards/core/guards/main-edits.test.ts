import { describe, expect, test } from "bun:test";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { mainEditsGuard } from "./main-edits";

// A deliberately fake repo root (not under /Users — see paths:no-hardcoded-paths).
const REPO = "/r/repo";
const WT = `${REPO}/.claude/worktrees/att-123-abcd`;
const OTHER_WT = `${REPO}/.claude/worktrees/att-999-zzzz`;

function verdict(filePath: string, cwd: string): Verdict {
  // Synchronous check; the fake cwd never holds a bypass token file.
  return mainEditsGuard.check(
    { file_path: filePath },
    createContext(cwd),
  ) as Verdict;
}
const blocks = (f: string, cwd: string) => verdict(f, cwd).kind === "deny";
function denyReason(f: string, cwd: string): string {
  const v = verdict(f, cwd);
  return v.kind === "deny" ? v.reason : "";
}

describe("main-edits guard", () => {
  describe("boundary is the worktree root, not raw cwd", () => {
    test("allows edits under the worktree root when cwd IS the root", () => {
      expect(blocks(`${WT}/research/doc.md`, WT)).toBe(false);
    });

    test("allows sibling-dir edits when cwd is a worktree SUBDIRECTORY (2026-07-07 false positive)", () => {
      expect(blocks(`${WT}/research/doc.md`, `${WT}/gateway`)).toBe(false);
    });

    test("allows deep edits from a deep unrelated cwd inside the same worktree", () => {
      expect(
        blocks(
          `${WT}/plugins/a/core/index.ts`,
          `${WT}/plugins/b/web/components`,
        ),
      ).toBe(false);
    });

    test("outside a worktree, cwd itself is the boundary", () => {
      expect(blocks("/some/dir/file.ts", "/some/dir")).toBe(false);
      expect(blocks("/elsewhere/file.ts", "/some/dir")).toBe(true);
    });
  });

  describe("main-checkout edits stay blocked, with a correctly re-based hint", () => {
    test("blocked from the worktree root", () => {
      const reason = denyReason(`${REPO}/plugins/foo/core/index.ts`, WT);
      expect(reason).toContain(`Edit \`${WT}/plugins/foo/core/index.ts\``);
    });

    test("blocked from a worktree subdirectory — hint re-bases onto the worktree ROOT, not cwd", () => {
      const reason = denyReason(
        `${REPO}/plugins/foo/core/index.ts`,
        `${WT}/gateway`,
      );
      expect(reason).toContain(`Edit \`${WT}/plugins/foo/core/index.ts\``);
      // The old bug composed the suggestion onto cwd: <wt>/gateway/.claude/worktrees/...
      expect(reason).not.toContain(`${WT}/gateway/`);
    });
  });

  describe("another agent's worktree", () => {
    test("blocked, and the hint never composes a re-based nonsense path", () => {
      const reason = denyReason(`${OTHER_WT}/plugins/foo.ts`, `${WT}/gateway`);
      expect(reason).not.toBe("");
      expect(reason).not.toContain(`${WT}/.claude/worktrees/`);
    });
  });

  describe("standing allowances are unaffected", () => {
    test("/tmp", () => {
      expect(blocks("/tmp/scratch/x.md", `${WT}/gateway`)).toBe(false);
    });

    test("/private/tmp — macOS-resolved scratchpad (2026-07-08 false positive)", () => {
      // /tmp is a symlink to /private/tmp on macOS, so the harness scratchpad
      // surfaces as /private/tmp/claude-501/.../scratchpad/...
      expect(
        blocks(
          "/private/tmp/claude-501/session/scratchpad/gen_funk.py",
          `${WT}/gateway`,
        ),
      ).toBe(false);
    });
  });

  describe("declared data dirs handed in by the entry point", () => {
    // Stands in for `prototypesDir.path`: the guard never spells the directory
    // itself, so the test doesn't either — what it pins is the prefix rule.
    const DATA = "/r/data/apps/prototypes";
    const dirVerdict = (f: string): Verdict =>
      mainEditsGuard.check(
        { file_path: f },
        createContext(`${WT}/gateway`, "test", [DATA]),
      ) as Verdict;

    test("allows a write inside the declared dir (2026-08-18 false positive)", () => {
      // The block that started this: prototypes/CLAUDE.md sends every agent to
      // this tree, and the guard refused every write into it.
      expect(dirVerdict(`${DATA}/sketch-roll/index.html`).kind).toBe("allow");
    });

    test("allows the directory itself", () => {
      expect(dirVerdict(DATA).kind).toBe("allow");
    });

    test("a sibling whose name merely starts with it stays blocked", () => {
      expect(dirVerdict(`${DATA}-evil/index.html`).kind).toBe("deny");
    });

    test("with none handed in, the same path is blocked", () => {
      expect(blocks(`${DATA}/sketch-roll/index.html`, `${WT}/gateway`)).toBe(
        true,
      );
    });

    test("the denial names the dirs that WERE allowed", () => {
      const v = dirVerdict(`${DATA}-evil/index.html`);
      expect(v.kind === "deny" && v.reason).toContain(DATA);
    });
  });
});

describe("main-edits guard in a launch-named workspace", () => {
  const SCRATCH = "/s/state/workspaces/att-1-abcd";
  const launched = (f: string, cwd: string) =>
    mainEditsGuard.check(
      { file_path: f },
      createContext(cwd, "s", [], undefined, null, null, SCRATCH),
    ) as Verdict;

  test("a scratch agent edits anywhere in its workspace, from a subdirectory cwd", () => {
    expect(
      launched(`${SCRATCH}/out/score.xml`, `${SCRATCH}/sub`).kind,
    ).not.toBe("deny");
  });

  test("an edit outside it is refused, pointing back at the workspace", () => {
    const v = launched(`${REPO}/plugins/x.ts`, `${SCRATCH}/sub`);
    expect(v.kind).toBe("deny");
    expect(v.kind === "deny" && v.reason).toContain(`workspace ${SCRATCH}`);
  });
});
