/**
 * `runAttached` leaves the record a backend-started run leaves — the
 * transcript (stdout and stderr merged, in order) and the exit marker — and
 * hands the child's status back. Driven with real children under a temp data
 * root, read back through the same reader every consumer uses.
 */
import {
  readEnv,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeArtifacts } from "@plugins/infra/plugins/paths/core";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import { readRunTerminal } from "../../core/internal/terminal";
import { runAttached } from "./attached";

const NS = asNamespace("attached-run-test");
const KIND = "attachedtest";

let dataRoot: string;
const priorDataRoot = readEnv("DIR");

beforeAll(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "sg-attached-run-"));
  // `worktreesDir()` reads this on every call, so the run paths resolve under
  // the temp root for the rest of the suite.
  setEnv("DIR", dataRoot);
});

afterAll(() => {
  if (priorDataRoot === undefined) unsetEnv("DIR");
  else setEnv("DIR", priorDataRoot);
  rmSync(dataRoot, { recursive: true, force: true });
});

let seq = 0;
const runId = (): string => `run-${process.pid}-${seq++}`;

function run(id: string, script: string): Promise<number> {
  return runAttached({
    namespace: NS,
    kindId: KIND,
    runId: id,
    argv: ["/bin/sh", "-c", script],
    env: { ...process.env },
  });
}

describe("runAttached", () => {
  test("writes the merged transcript and the marker, and returns the status", async () => {
    const id = runId();
    expect(await run(id, "echo one; echo two >&2; echo three; exit 3")).toBe(3);
    expect(
      readFileSync(worktreeArtifacts.runTranscript(NS, KIND, id), "utf-8"),
    ).toBe("one\ntwo\nthree\n");
    expect(readRunTerminal(KIND, id, NS)).toMatchObject({
      exitCode: 3,
      signalCode: null,
    });
  });

  test("hands the child its marker path, as the shim does", async () => {
    const id = runId();
    expect(await run(id, 'echo "$SUPERVISED_RUN_TERMINAL"')).toBe(0);
    expect(
      readFileSync(worktreeArtifacts.runTranscript(NS, KIND, id), "utf-8"),
    ).toBe(`${worktreeArtifacts.runTerminal(NS, KIND, id)}\n`);
  });

  test("a child killed by a signal records 128 + signo", async () => {
    const id = runId();
    expect(await run(id, "kill -TERM $$")).toBe(143);
    expect(readRunTerminal(KIND, id, NS)?.exitCode).toBe(143);
  });

  test("a run id already ended is refused, not overwritten", async () => {
    const id = runId();
    expect(await run(id, "true")).toBe(0);
    expect(run(id, "true")).rejects.toThrow(/run ids must be unique/);
  });
});
