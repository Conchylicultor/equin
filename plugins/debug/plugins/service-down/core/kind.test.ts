import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OutboxEntrySchema } from "@plugins/reports/plugins/outbox/plugins/file/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { ServiceDownPayloadSchema, describeServiceDown } from "./kind";

// The entry the gateway's Go writer produces (its own test asserts it builds
// exactly this): the cross-language contract, read by both sides.
const GOLDEN = join(REPO_ROOT, "gateway/testdata/service-down-entry.json");

describe("service-down", () => {
  test("the gateway's entry parses as an outbox entry of this kind", () => {
    const entry = OutboxEntrySchema.parse(
      JSON.parse(readFileSync(GOLDEN, "utf8")),
    );
    expect(entry.kind).toBe("service-down");
    const d = ServiceDownPayloadSchema.parse(entry.data);
    expect(d.outcome).toBe("crashed");
    expect(describeServiceDown(d)).toBe(
      "postgres stopped answering after 1h 00m up; re-start failed, left down",
    );
  });

  test("a recovered outage says how long it lasted", () => {
    const d = ServiceDownPayloadSchema.parse({
      service: "pgbouncer",
      probe: "unix /x/.s.PGSQL.6432",
      probeError:
        "dial unix /x/.s.PGSQL.6432: connect: no such file or directory",
      upSince: null,
      detectedAt: 0,
      outcome: "recovered",
      settledAt: 4_200,
      restartError: null,
      restartOutput: ["pgbouncer: removing stale pidfile"],
      logPath: "/x/pgbouncer.log",
      logTail: [],
      logTailError: null,
    });
    expect(describeServiceDown(d)).toBe(
      "pgbouncer stopped answering; re-started, back after 4.2s",
    );
  });
});
