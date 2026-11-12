import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OutboxEntrySchema } from "@plugins/reports/plugins/outbox/plugins/file/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import {
  MainDeployFailedPayloadSchema,
  describeMainDeployFailed,
} from "./kind";

// The entry the gateway's Go writer produces (its own test asserts it builds
// exactly this): the cross-language contract, read by both sides.
const GOLDEN = join(
  REPO_ROOT,
  "gateway/testdata/main-deploy-failed-entry.json",
);

describe("main-deploy-failed", () => {
  test("the gateway's entry parses as an outbox entry of this kind", () => {
    const entry = OutboxEntrySchema.parse(
      JSON.parse(readFileSync(GOLDEN, "utf8")),
    );
    expect(entry.kind).toBe("main-deploy-failed");
    const d = MainDeployFailedPayloadSchema.parse(entry.data);
    expect(describeMainDeployFailed(d)).toBe(
      "main's deploy run failed (exit 1) — started by ref advanced",
    );
  });

  test("a run that could not start says so", () => {
    const d = MainDeployFailedPayloadSchema.parse({
      exitCode: null,
      signal: null,
      spawnError: "fork/exec /x/equin: no such file or directory",
      causes: ["gateway boot"],
      tail: [],
      checkout: "/x",
      log: "/x/deploy/main.log",
      startedAt: 0,
      endedAt: 0,
    });
    expect(describeMainDeployFailed(d)).toBe(
      "main's deploy run could not start — started by gateway boot",
    );
  });
});
