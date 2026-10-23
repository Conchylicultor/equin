import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { backgroundOpsGuard } from "./background-ops";

function verdict(command: string, run_in_background?: boolean): Verdict {
  return backgroundOpsGuard.check(
    { command, run_in_background },
    createContext("/tmp"),
  ) as Verdict;
}

/**
 * The same call as `verdict`, but made by a subagent. A real session id per
 * call, because the guard records the started op under it — sharing one would
 * let these tests write over each other's ledger.
 */
const scratch: string[] = [];
function subagentVerdict(
  command: string,
  run_in_background?: boolean,
): Verdict {
  const cwd = mkdtempSync(join(tmpdir(), "bg-ops-"));
  const sessionId = `bg-ops-test-${scratch.length}-${process.pid}`;
  scratch.push(cwd, join(tmpdir(), `guard-agent-ops-${sessionId}.json`));
  return backgroundOpsGuard.check(
    { command, run_in_background },
    createContext(cwd, sessionId, [], undefined, {
      id: "agent-1",
      type: "general-purpose",
    }),
  ) as Verdict;
}

// The guard records the started op under its session id. Left behind, those
// files accumulate in the host's temp dir on every test run.
afterAll(() => {
  for (const path of scratch) rmSync(path, { force: true, recursive: true });
});

const blocks = (command: string, bg?: boolean) =>
  verdict(command, bg).kind === "deny";
const reason = (command: string, bg?: boolean) => {
  const v = verdict(command, bg);
  return v.kind === "deny" ? v.reason : "";
};

describe("background-ops guard", () => {
  describe("long ops in the foreground are blocked", () => {
    for (const op of ["build", "push", "check", "test", "release"]) {
      for (const cli of ["./equin", "./singularity"]) {
        test(`${cli} ${op}`, () => {
          expect(blocks(`${cli} ${op}`)).toBe(true);
        });
      }
    }

    test("the exact shape from conv-1786116592-b70n", () => {
      expect(
        blocks(
          `./singularity push -m "feat(data-view): properties" 2>&1 | tail -50`,
        ),
      ).toBe(true);
    });

    test("behind a cd, as agents usually write it", () => {
      expect(
        blocks(
          // Fake root, deliberately not under /Users — see `paths:no-hardcoded-paths`.
          `cd /r/repo/.claude/worktrees/att-1 && ./singularity build`,
        ),
      ).toBe(true);
    });

    test("hidden inside a loop body — the parseShell blind spot", () => {
      expect(blocks(`until false; do ./singularity build; done`)).toBe(true);
    });

    test("the denial names run_in_background", () => {
      expect(reason("./singularity build")).toContain("run_in_background");
    });
  });

  describe("backgrounded long ops are allowed", () => {
    test("build with the flag", () => {
      expect(blocks("./singularity build", true)).toBe(false);
    });

    test("push with the flag and a pipe", () => {
      expect(blocks(`./singularity push -m "x" 2>&1 | tail -50`, true)).toBe(
        false,
      );
    });
  });

  describe("shell-level detach is not backgrounding", () => {
    test("trailing & in the foreground", () => {
      expect(blocks("./singularity build &")).toBe(true);
    });

    test("nohup", () => {
      expect(blocks("nohup ./singularity build")).toBe(true);
    });

    test("trailing & even WITH run_in_background, because it fakes completion", () => {
      expect(blocks("./singularity build &", true)).toBe(true);
    });

    test("2>&1 is a redirection, not a detach", () => {
      expect(blocks("./singularity build 2>&1", true)).toBe(false);
    });
  });

  describe("a subagent is told to await, because nothing will wake it", () => {
    test("a backgrounded op is still allowed — the op itself is fine", () => {
      const v = subagentVerdict("./singularity build", true);
      expect(v.kind).not.toBe("deny");
    });

    test("… but it is told to await instead of ending its turn", () => {
      const v = subagentVerdict("./singularity build", true);
      expect(v.kind).toBe("inform");
      expect(v.kind === "inform" && v.context).toContain("./equin await build");
      expect(v.kind === "inform" && v.context).toContain("NOT reach you");
    });

    test("the main conversation is told nothing new — its notification works", () => {
      expect(verdict("./singularity build", true).kind).toBe("allow");
    });

    test("a foreground op still denies, but the hint names both steps", () => {
      const v = subagentVerdict("./singularity test");
      expect(v.kind).toBe("deny");
      expect(v.kind === "deny" && v.reason).toContain("run_in_background");
      expect(v.kind === "deny" && v.reason).toContain("./equin await test");
    });

    test("the main conversation's foreground hint still says to end its turn", () => {
      const v = verdict("./singularity test");
      expect(v.kind === "deny" && v.reason).toContain("END YOUR TURN");
    });

    test("a subagent detaching with & is denied like anyone else", () => {
      expect(subagentVerdict("./singularity build &", true).kind).toBe("deny");
    });

    test("a command that is not a long op says nothing to a subagent either", () => {
      expect(subagentVerdict("ls -la", true).kind).toBe("allow");
    });
  });

  describe("documents are written, not run", () => {
    const S = "./singularity";

    test("the repro: a research doc mentioning the build in inline code", () => {
      const cmd = [
        "cat > research/x.md <<'EOF'",
        "## Verification",
        "",
        "- `" + S + " build --composition sonata` from an agent worktree",
        "- `" + S + " build` with no flag is byte-equivalent",
        "EOF",
      ].join("\n");
      expect(blocks(cmd)).toBe(false);
    });

    test("… and in a fenced code block", () => {
      const cmd = [
        "cat > doc.md <<'EOF'",
        "```bash",
        S + " build",
        "```",
        "EOF",
      ].join("\n");
      expect(blocks(cmd)).toBe(false);
    });

    test("a script whose body ends in & is not a detach", () => {
      const cmd = ["cat > s.sh <<'EOF'", S + " build &", "EOF"].join("\n");
      expect(blocks(cmd)).toBe(false);
    });

    test("a commit message body is data, but the push it decorates is not", () => {
      const cmd = [
        S + " push -m \"$(cat <<'EOF'",
        "fix(x): a thing",
        "",
        "Ran `" + S + " build` first",
        "EOF",
        ')"',
      ].join("\n");
      expect(blocks(cmd)).toBe(true);
      expect(blocks(cmd, true)).toBe(false);
    });

    test("… including when the message body holds an unpaired quote", () => {
      const cmd = [
        S + " push -m \"$(cat <<'EOF'",
        'He said "hi and ran `' + S + " build` then",
        "EOF",
        ')"',
      ].join("\n");
      expect(blocks(cmd)).toBe(true);
      expect(blocks(cmd, true)).toBe(false);
    });

    test("the scanner resumes after a terminator", () => {
      const cmd = ["python3 - <<'PY'", "print(1)", "PY", S + " check"].join(
        "\n",
      );
      expect(blocks(cmd)).toBe(true);
    });

    test("a body piped into a shell really runs", () => {
      const cmd = ["cat <<'EOF' | bash", S + " build", "EOF"].join("\n");
      expect(blocks(cmd)).toBe(true);
    });
  });

  describe("short commands stay allowed", () => {
    test("check --list", () => {
      expect(blocks("./singularity check --list")).toBe(false);
    });

    test("--help", () => {
      expect(blocks("./singularity build --help")).toBe(false);
    });

    test("an unrelated command", () => {
      expect(blocks("git status")).toBe(false);
    });

    test("a different binary named similarly", () => {
      expect(blocks("echo ./singularity build")).toBe(false);
    });
  });
});
