import { describe, expect, test } from "bun:test";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { envName } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { sharedTmpGuard } from "./shared-tmp";

const WT = "/r/repo/.claude/worktrees/att-123-abcd";
const LAUNCHED = "/tmp/equin-scratch/conv-1-abc";
const SESSION = "615f223d-ac72-45b2-9bb8-6f7d361d78da";

type Input = { file_path?: string; notebook_path?: string; command?: string };

function verdict(input: Input, scratch: string | null = LAUNCHED): Verdict {
  const ctx = createContext(
    WT,
    SESSION,
    [],
    undefined,
    null,
    null,
    WT,
    scratch,
  );
  return (sharedTmpGuard.check(input, ctx) ?? { kind: "allow" }) as Verdict;
}
const blocks = (input: Input) => verdict(input).kind === "deny";
const cmd = (command: string) => blocks({ command });

describe("shared-tmp guard", () => {
  test("the 2026-11-08 incident: the message file write is refused", () => {
    expect(
      cmd(
        "cat > /tmp/msg.txt <<'EOF'\nfix: x\nEOF\n./equin push -m \"$(cat /tmp/msg.txt)\"",
      ),
    ).toBe(true);
    expect(blocks({ file_path: "/tmp/msg.txt" })).toBe(true);
    expect(blocks({ file_path: "/private/tmp/review.md" })).toBe(true);
    expect(blocks({ notebook_path: "/tmp/n.ipynb" })).toBe(true);
  });

  test("writes by redirection, known writers and cwd are refused", () => {
    expect(cmd("./equin check 2>&1 | tee /tmp/tc.log")).toBe(true);
    expect(cmd("./equin test x > /tmp/t.log 2>&1")).toBe(true);
    expect(cmd("echo hi >> /var/tmp/x")).toBe(true);
    expect(cmd("cp a.txt /tmp/b.txt")).toBe(true);
    expect(cmd("mkdir -p /tmp/bp10")).toBe(true);
    expect(cmd("cd /tmp && cat > msg.txt <<'EOF'\nx\nEOF")).toBe(true);
    expect(cmd("cd /tmp && tar czf out.tgz x")).toBe(true);
    expect(cmd("cd /tmp/fsev-tap && ls")).toBe(true);
    expect(cmd("curl -s http://x -o /tmp/optime/snap.json")).toBe(true);
    expect(cmd("python3 /tmp/fiximp.py a.ts")).toBe(true);
    expect(cmd("dd if=/dev/zero of=/tmp/a bs=1 count=1")).toBe(true);
    expect(cmd("bash -c 'echo x > /tmp/a'")).toBe(true);
    expect(cmd('sh -lc "cd /tmp && tar czf o.tgz x"')).toBe(true);
    expect(cmd("eval 'echo x > /tmp/a'")).toBe(true);
    expect(cmd("git clone https://x/y.git /tmp/y")).toBe(true);
  });

  test("an unknown command handed a fixed temp path is refused", () => {
    expect(cmd("./equin run e2e/screenshot.ts --out /tmp/shot")).toBe(true);
    expect(cmd("./equin run e2e/screenshot.ts --out=/tmp/shot")).toBe(true);
    expect(cmd("go build -o /tmp/gateway .")).toBe(true);
    expect(cmd("git bundle create /tmp/main.bundle main")).toBe(true);
  });

  test("another session's scratch is not this one's", () => {
    expect(cmd("echo x > /tmp/equin-scratch/conv-2/msg.txt")).toBe(true);
  });

  test("this session's scratch, unique names and reads pass", () => {
    expect(cmd(`cat > ${LAUNCHED}/msg.txt <<'EOF'\nx\nEOF`)).toBe(false);
    expect(cmd(`cat > "$${envName("SCRATCH")}/msg.txt" <<'EOF'\nx\nEOF`)).toBe(
      false,
    );
    expect(blocks({ file_path: `${LAUNCHED}/review.md` })).toBe(false);
    expect(cmd('f=$(mktemp); ./equin check > "$f"')).toBe(false);
    expect(cmd("mktemp /tmp/x.XXXXXX")).toBe(false);
    expect(cmd("cat /tmp/claude-501/x/tasks/b1.output")).toBe(false);
    expect(cmd("tail -50 /tmp/some.log; ls /tmp; rg foo /tmp/x.log")).toBe(
      false,
    );
    expect(blocks({ file_path: `${WT}/plugins/a.ts` })).toBe(false);
    expect(cmd("cp /tmp/tree-oracle.bak plugins/x.ts")).toBe(false);
    expect(cmd("sed -n 1,20p /tmp/equin-test-LqgCmT/output.log")).toBe(false);
    expect(
      cmd(
        `git diff > /private/tmp/claude-501/-r-repo/${SESSION}/scratchpad/p.patch`,
      ),
    ).toBe(false);
    expect(
      cmd("echo x > /tmp/claude-501/-r-repo/other-session/scratchpad/p"),
    ).toBe(true);
  });

  test("a message that mentions a temp path is not a write", () => {
    expect(
      cmd(
        "./equin push -m \"$(cat <<'EOF'\nfix: /tmp/msg.txt was shared\nEOF\n)\"",
      ),
    ).toBe(false);
    expect(cmd('./equin push -m "/tmp/msg.txt was shared"')).toBe(false);
  });

  test("without a delivered scratch dir, the session id names it", () => {
    const v = verdict({ file_path: "/tmp/msg.txt" }, null);
    expect(v.kind).toBe("deny");
    if (v.kind !== "deny") return;
    expect(v.reason).toContain(`/tmp/equin-scratch/${SESSION}`);
    expect(v.reason).toContain("mkdir -p");
    expect(blocks({ file_path: `/tmp/equin-scratch/${SESSION}/m` })).toBe(true); // a launched session's scratch is the conversation's
    expect(
      verdict({ file_path: `/tmp/equin-scratch/${SESSION}/m` }, null).kind,
    ).toBe("allow");
  });

  test("the denial names the scratch variable for a launched session", () => {
    const v = verdict({ command: "echo x > /tmp/msg.txt" });
    expect(v.kind).toBe("deny");
    if (v.kind !== "deny") return;
    expect(v.reason).toContain(`"$${envName("SCRATCH")}/msg.txt"`);
    expect(v.reason).toContain(LAUNCHED);
  });
});
