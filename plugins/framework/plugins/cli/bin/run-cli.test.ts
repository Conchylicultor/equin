import { afterEach, expect, spyOn, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./run-cli";

// Regression guard: a Commander async action that rejects must translate into a
// non-zero exit code at the process boundary, or callers keying on $? read a
// failed build/push/check as success.

// process.exitCode is global state — capture and restore it around each test,
// and silence the loud error print so a thrown-action test doesn't pollute
// output.
const originalExitCode = process.exitCode;
let errorSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  // `undefined` does not reset a set exit code under bun: restore 0 instead,
  // or a throwing test run last leaves the test process exiting 1.
  process.exitCode = originalExitCode ?? 0;
  errorSpy?.mockRestore();
  errorSpy = undefined;
});

test("async action that throws → exitCode 1", async () => {
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const cmd = new Command();
  cmd
    .command("boom")
    .action(async () => {
      throw new Error("boom");
    });

  await runCli(cmd, ["node", "cli", "boom"]);

  expect(process.exitCode).toBe(1);
  expect(errorSpy).toHaveBeenCalled();
});

test("async action that succeeds → exit code not forced to 1", async () => {
  const cmd = new Command();
  cmd.command("ok").action(async () => {
    // resolves cleanly
  });

  process.exitCode = 0;
  await runCli(cmd, ["node", "cli", "ok"]);

  expect(process.exitCode).toBe(0);
});

test("a supervised run's child records its crash, message first, where the shim said", async () => {
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  const dir = mkdtempSync(join(tmpdir(), "run-cli-"));
  const path = join(dir, "kind-run.error");
  process.env.SUPERVISED_RUN_ERROR = path;
  try {
    const cmd = new Command();
    cmd.command("boom").action(async () => {
      throw new Error("the tree changed on disk");
    });
    await runCli(cmd, ["node", "cli", "boom"]);
    expect(readFileSync(path, "utf8")).toStartWith(
      "Error: the tree changed on disk",
    );
    // Taken out of the environment, so a command this one spawns cannot
    // write over the record.
    expect(process.env.SUPERVISED_RUN_ERROR).toBeUndefined();
  } finally {
    delete process.env.SUPERVISED_RUN_ERROR;
    rmSync(dir, { recursive: true, force: true });
  }
});
