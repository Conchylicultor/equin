import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OutboxEntrySchema } from "@plugins/reports/plugins/outbox/plugins/file/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  BackendExitPayloadSchema,
  describeBackendExit,
  exitErrorLineOf,
} from "./exit-kind";

// The entry the gateway's Go writer produces (its own test asserts it builds
// exactly this): the cross-language contract, read by both sides.
const GOLDEN = join(REPO_ROOT, "gateway/testdata/backend-exit-entry.json");

describe("backend-exit", () => {
  test("the gateway's entry parses as an outbox entry of this kind", () => {
    const entry = OutboxEntrySchema.parse(
      JSON.parse(readFileSync(GOLDEN, "utf8")),
    );
    expect(entry.kind).toBe("backend-exit");
    const d = BackendExitPayloadSchema.parse(entry.data);
    expect(d.exitCode).toBe(1);
    expect(describeBackendExit(d)).toBe(
      "main exited with code 1 5.5s after ready (14.2s up)",
    );
    expect(exitErrorLineOf(d)).toStartWith(
      "[process-crash] uncaughtException: error: conversations_ext_sdk_agent_stop",
    );
  });

  test("a boot death says so, and a tail with no error line reads null", () => {
    const d = BackendExitPayloadSchema.parse({
      worktree: "alpha",
      pid: 7,
      exitCode: 4,
      startedAt: 0,
      exitedAt: 3_000,
      readyAt: null,
      executable: "bun",
      stderrTail: ["[boot] loading plugins"],
      stderrComplete: true,
    });
    expect(describeBackendExit(d)).toBe(
      "alpha exited with code 4 while booting, after 3.0s",
    );
    expect(exitErrorLineOf(d)).toBeNull();
  });
});
