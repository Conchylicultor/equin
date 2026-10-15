import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { conversationOfMailboxFile, promptSubmitHookCommand } from "./mailbox";

describe("promptSubmitHookCommand", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "prompt-submits-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The command as the CLI runs it: through a shell, the hook payload on stdin,
  // the two variables the pane delivers in its environment.
  async function runHook(payload: string, env: Record<string, string>) {
    return spawnCaptured(["/bin/sh", "-c", promptSubmitHookCommand(dir)], {
      stdin: payload,
      env: { PATH: "/usr/bin:/bin", ...env },
      timeoutMs: 10_000,
    });
  }

  test("writes the payload into the launching backend's folder, silently, exiting 0", async () => {
    const payload = JSON.stringify({
      prompt: "line one\n> two",
      prompt_id: "p",
    });
    const result = await runHook(payload, {
      SINGULARITY_PARENT_HOST: "singularity",
      SINGULARITY_CONVERSATION_ID: "conv-1791000000-abc123",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    const files = readdirSync(join(dir, "singularity"));
    expect(files).toHaveLength(1);
    expect(conversationOfMailboxFile(files[0]!)).toBe("conv-1791000000-abc123");
    expect(readFileSync(join(dir, "singularity", files[0]!), "utf8")).toBe(
      payload,
    );
  });

  test("exits 0 and prints nothing even when it cannot write", async () => {
    const result = await runHook("{}", {
      SINGULARITY_PARENT_HOST: "../../../../../../proc/none",
      SINGULARITY_CONVERSATION_ID: "conv-x",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("refuses a mailbox path unsafe to splice into a command", () => {
    expect(() => promptSubmitHookCommand('/srv/o"brien')).toThrow(/plain/);
    expect(() => promptSubmitHookCommand("relative/dir")).toThrow(/absolute/);
  });
});

describe("conversationOfMailboxFile", () => {
  test("reads the conversation from a finished file only", () => {
    expect(conversationOfMailboxFile("conv-1-ab.1791000000.4242.json")).toBe(
      "conv-1-ab",
    );
    expect(
      conversationOfMailboxFile("conv-1-ab.1791000000.4242.tmp"),
    ).toBeNull();
    expect(conversationOfMailboxFile("README")).toBeNull();
  });
});
