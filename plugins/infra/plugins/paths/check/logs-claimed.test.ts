import { expect, test } from "bun:test";
import { auditLogs, type ClaimingDir } from "./internal/logs-claimed";
import type { DataDirsManifest } from "../core/internal/data-dirs-manifest";

const gateway: ClaimingDir = {
  key: "logs/gateway",
  root: "/r/logs/gateway",
  claims: [
    { pattern: "*.log", bound: { kind: "gateway-rotating" } },
    {
      pattern: "legacy.log",
      bound: { kind: "debt", reason: "r", task: "task-1" },
    },
  ],
};

function manifest(namespace: string, logClaims: string[]): DataDirsManifest {
  return {
    version: 1,
    namespace,
    writtenAt: "",
    keys: [],
    rootEntries: [],
    logClaims,
  };
}

test("claimed files pass; an unclaimed one is reported with its size", () => {
  const audit = auditLogs(
    [
      {
        dir: gateway,
        files: [
          { rel: "att-1.log", bytes: 1 },
          { rel: "att-1.log.2", bytes: 1 },
          { rel: "services/postgres.log", bytes: 7 },
        ],
      },
    ],
    [],
  );
  expect(audit.unclaimed).toEqual([
    { path: "logs/gateway/services/postgres.log", bytes: 7 },
  ]);
});

test("first matching claim wins, and a debt claim is tallied, not failed", () => {
  const dir: ClaimingDir = {
    ...gateway,
    claims: [...gateway.claims].reverse(),
  };
  const audit = auditLogs(
    [
      {
        dir,
        files: [
          { rel: "legacy.log", bytes: 5 },
          { rel: "legacy.log.1", bytes: 3 },
        ],
      },
    ],
    [],
  );
  expect(audit.unclaimed).toEqual([]);
  expect(audit.debt).toEqual([
    { claim: "logs/gateway:legacy.log", task: "task-1", files: 2, bytes: 8 },
  ]);
});

test("a claim another live branch publishes for the same dir excuses the file", () => {
  const audit = auditLogs(
    [{ dir: gateway, files: [{ rel: "services/postgres.log", bytes: 7 }] }],
    [
      manifest("att-other-dir", ["logs/elsewhere:services/*.log"]),
      manifest("att-owner", ["logs/gateway:services/*.log"]),
    ],
  );
  expect(audit.unclaimed).toEqual([]);
  expect(audit.attributed).toEqual([
    { path: "logs/gateway/services/postgres.log", owners: ["att-owner"] },
  ]);
});
