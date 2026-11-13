import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditLogs,
  findLogs,
  type ClaimingDir,
  type FoundLog,
} from "./internal/logs-claimed";
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

function found(rel: string): FoundLog {
  return { rel, abs: `/r/logs/gateway/${rel}` };
}

const noForeign = (): DataDirsManifest[] => {
  throw new Error("foreign manifests read with every file claimed locally");
};

test("claimed files pass; an unclaimed one is reported", () => {
  const audit = auditLogs(
    [
      {
        dir: gateway,
        files: [
          found("att-1.log"),
          found("att-1.log.2"),
          found("services/postgres.log"),
        ],
      },
    ],
    () => [],
  );
  expect(audit.unclaimed).toEqual([
    {
      path: "logs/gateway/services/postgres.log",
      abs: "/r/logs/gateway/services/postgres.log",
    },
  ]);
});

test("first matching claim wins, and a debt claim is tallied, not failed", () => {
  const dir: ClaimingDir = {
    ...gateway,
    claims: [...gateway.claims].reverse(),
  };
  const audit = auditLogs(
    [{ dir, files: [found("legacy.log"), found("legacy.log.1")] }],
    noForeign,
  );
  expect(audit.unclaimed).toEqual([]);
  expect(audit.debt).toEqual([
    {
      claim: "logs/gateway:legacy.log",
      task: "task-1",
      files: ["/r/logs/gateway/legacy.log", "/r/logs/gateway/legacy.log.1"],
    },
  ]);
});

test("every file claimed locally: no other namespace's manifest is read", () => {
  const audit = auditLogs(
    [{ dir: gateway, files: [found("a.log"), found("b.log.1")] }],
    noForeign,
  );
  expect(audit.unclaimed).toEqual([]);
});

test("a claim another live branch publishes for the same dir excuses the file", () => {
  const audit = auditLogs(
    [{ dir: gateway, files: [found("services/postgres.log")] }],
    () => [
      manifest("att-other-dir", ["logs/elsewhere:services/*.log"]),
      manifest("att-owner", ["logs/gateway:services/*.log"]),
    ],
  );
  expect(audit.unclaimed).toEqual([]);
  expect(audit.attributed).toEqual([
    { path: "logs/gateway/services/postgres.log", owners: ["att-owner"] },
  ]);
});

test("the walk finds logs at any depth, but not inside a notLogs subtree or another declared dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "logs-claimed-"));
  try {
    const put = (rel: string): void => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), "");
    };
    put("top.log");
    put("call-1/run-1/frames/a.jpg");
    put("call-1/run-1/stray.jsonl");
    put("call-1/loose.log");
    put("data-pg18/base/1/x.log");
    put("deep/er/still.log.3");
    put("nested/own.log");
    const files = await findLogs(root, new Set([join(root, "nested")]), [
      { pattern: "call-*/*", reason: "runs, deleted whole" },
      { pattern: "data-pg*", reason: "Postgres's data" },
    ]);
    expect(files.map((f) => f.rel).sort()).toEqual([
      "call-1/loose.log",
      "deep/er/still.log.3",
      "top.log",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
