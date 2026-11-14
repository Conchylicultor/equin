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
    { writableDataDirs: [], workspaceRoot: WORK, scratchDir: null },
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

describe("a guard bypass (postgres, a hard denial)", () => {
  const REASON = "--reason 'read-only listing of the throwaway test cluster'";
  /** The bypass id the denial printed. */
  function idOf(reason: string | null): string {
    const m = /guard bypass (\S+#\S+) --reason/.exec(reason ?? "");
    if (!m) throw new Error(`no bypass id in: ${reason}`);
    return m[1]!;
  }

  test("every hard denial names the bypass command for that exact call", async () => {
    const reason = denial(await bash(newSession(), "psql -l"));
    expect(idOf(reason)).toStartWith("postgres#");
    expect(reason).toContain("as its OWN tool call");
  });

  test("a warning (allowOnRepeat) offers the repeat, not a bypass", async () => {
    const reason = denial(await bash(newSession(), "rg foo ~"));
    expect(reason).not.toContain("guard bypass");
  });

  test("bypassed once: the retry passes, the next one is refused again", async () => {
    const s = newSession();
    const id = idOf(denial(await bash(s, "psql -l")));
    expect(
      denial(await bash(s, `./equin guard bypass ${id} ${REASON}`)),
    ).toBeNull();
    const retry = await bash(s, "psql -l");
    expect(denial(retry)).toBeNull();
    expect(JSON.stringify(retry)).toContain("was bypassed for this call");
    expect(denial(await bash(s, "psql -l"))).not.toBeNull();
  });

  test("covers only the call it names", async () => {
    const s = newSession();
    const id = idOf(denial(await bash(s, "psql -l")));
    await bash(s, `./equin guard bypass ${id} ${REASON}`);
    expect(denial(await bash(s, "psql -c 'select 1'"))).not.toBeNull();
  });

  test("covers only the agent that asked", async () => {
    const s = newSession();
    const id = idOf(denial(await bash(s, "psql -l")));
    await bash(s, `./equin guard bypass ${id} ${REASON}`);
    expect(
      denial(await bash(s, "psql -l", { agent_id: "sub-1" })),
    ).not.toBeNull();
  });

  test("refuses a bypass without a real reason", async () => {
    const s = newSession();
    const id = idOf(denial(await bash(s, "psql -l")));
    expect(
      denial(await bash(s, `./equin guard bypass ${id} --reason ok`)),
    ).toContain("--reason must say why");
    expect(denial(await bash(s, "psql -l"))).not.toBeNull();
  });

  test("refuses a bypass chained with other commands", async () => {
    const s = newSession();
    const id = idOf(denial(await bash(s, "psql -l")));
    expect(
      denial(await bash(s, `./equin guard bypass ${id} ${REASON} && psql -l`)),
    ).toContain("as its own tool call");
    expect(denial(await bash(s, "psql -l"))).not.toBeNull();
  });
});

describe("a foreground build backgrounded by background-ops", () => {
  test("runs backgrounded, at the 2 h ceiling, the command unchanged", async () => {
    const out = await bash(newSession(), "./equin build 2>&1");
    const specific = out?.hookSpecificOutput as
      | { updatedInput?: Record<string, unknown>; additionalContext?: string }
      | undefined;
    // background-timeout judges the rewritten input, so it raises the timeout.
    expect(specific?.updatedInput).toEqual({
      command: "./equin build 2>&1",
      run_in_background: true,
      timeout: 7_200_000,
    });
    expect(specific?.additionalContext).toContain("END YOUR TURN");
  });

  test("a tail of its output keeps the op's exit status (pipefail still applies)", async () => {
    const out = await bash(newSession(), "./equin push -m x 2>&1 | tail -15");
    const specific = out?.hookSpecificOutput as
      { updatedInput?: Record<string, unknown> } | undefined;
    expect(specific?.updatedInput?.run_in_background).toBe(true);
    expect(specific?.updatedInput?.command).toBe(
      "set -o pipefail; ./equin push -m x 2>&1 | tail -15",
    );
  });

  test("a compound form is still refused", async () => {
    const reason = denial(await bash(newSession(), "./equin build | head -15"));
    expect(reason).toContain("run_in_background");
  });
});
