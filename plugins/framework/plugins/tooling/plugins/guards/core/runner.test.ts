import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPEAT_TO_PROCEED, runHook, type HookOutput } from "./runner";

// A workspace outside any repo: `rg foo ~` from it walks the home directory,
// which `search-scope` refuses — with `allowOnRepeat`.
const WORK = mkdtempSync(join(tmpdir(), "guard-runner-"));
const used: string[] = [];
afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
  // informed-once's per-session state file.
  for (const s of used)
    rmSync(join(tmpdir(), `guard-informed-once-${s}.json`), { force: true });
});

/** A fresh session per test: the repeat memory is per session, in tmpdir. */
function newSession(): string {
  const s = `runner-test-${process.pid}-${Date.now()}-${used.length}`;
  used.push(s);
  return s;
}

function bash(
  session: string,
  command: string,
  extra: { description?: string; agent_id?: string } = {},
): Promise<HookOutput | null> {
  const { description, agent_id } = extra;
  return runHook(
    {
      tool_name: "Bash",
      tool_input: { command, ...(description ? { description } : {}) },
      cwd: WORK,
      session_id: session,
      ...(agent_id ? { agent_id, agent_type: "general-purpose" } : {}),
    },
    { writableDataDirs: [], workspaceRoot: WORK },
  );
}

function denial(out: HookOutput | null): string | null {
  const specific = out?.hookSpecificOutput as
    | { permissionDecision?: string; permissionDecisionReason?: string }
    | undefined;
  return specific?.permissionDecision === "deny"
    ? (specific.permissionDecisionReason ?? "")
    : null;
}

describe("an allowOnRepeat denial (search-scope)", () => {
  test("the first call is refused, saying how to proceed", async () => {
    const reason = denial(await bash(newSession(), "rg foo ~"));
    expect(reason).toContain("would walk");
    expect(reason).toContain(REPEAT_TO_PROCEED);
    // The "STOP, do not work around" epilogue would contradict it.
    expect(reason).not.toContain("STOP immediately");
  });

  test("the identical repeat goes through", async () => {
    const s = newSession();
    expect(denial(await bash(s, "rg foo ~"))).not.toBeNull();
    expect(denial(await bash(s, "rg foo ~"))).toBeNull();
  });

  test("a new description is still the same call", async () => {
    const s = newSession();
    expect(
      denial(await bash(s, "rg foo ~", { description: "a" })),
    ).not.toBeNull();
    expect(denial(await bash(s, "rg foo ~", { description: "b" }))).toBeNull();
  });

  test("a changed call is judged afresh", async () => {
    const s = newSession();
    expect(denial(await bash(s, "rg foo ~"))).not.toBeNull();
    expect(denial(await bash(s, "rg bar ~"))).not.toBeNull();
  });

  test("another agent of the session has not been warned", async () => {
    const s = newSession();
    expect(denial(await bash(s, "rg foo ~"))).not.toBeNull();
    expect(
      denial(await bash(s, "rg foo ~", { agent_id: "sub-1" })),
    ).not.toBeNull();
  });

  test("another session has not been warned", async () => {
    expect(denial(await bash(newSession(), "rg foo ~"))).not.toBeNull();
    expect(denial(await bash(newSession(), "rg foo ~"))).not.toBeNull();
  });
});
