import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { OutboxEntrySchema, isOutboxEntryName } from "./entry";
import {
  OUTBOX_MAX_PENDING,
  fileReportFromProcess,
  fileReportFromProcessSync,
} from "./file-report";

// Never the host-global outbox: a test entry there would be drained by main
// and filed as a real report.
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "report-outbox-write-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const MERGE_BASE = "a".repeat(40);

describe("fileReportFromProcess", () => {
  test("writes one complete, parseable entry and no temp file", async () => {
    const result = await fileReportFromProcess(
      {
        kind: "some-kind",
        message: "hello",
        data: { n: 1 },
        code: {
          mergeBase: MERGE_BASE,
          paths: ["plugins/reports/plugins/outbox/core/index.ts"],
        },
      },
      { dir, now: 1234 },
    );
    expect(result.outcome).toBe("written");
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    const name = names[0] ?? "";
    expect(isOutboxEntryName(name)).toBe(true);
    const entry = OutboxEntrySchema.parse(
      JSON.parse(await readFile(join(dir, name), "utf8")),
    );
    expect(entry).toMatchObject({
      version: 1,
      kind: "some-kind",
      message: "hello",
      data: { n: 1 },
      occurredAt: 1234,
      code: {
        mergeBase: MERGE_BASE,
        paths: ["plugins/reports/plugins/outbox/core/index.ts"],
      },
      writer: { pid: process.pid },
    });
  });

  test("refuses once the outbox holds the cap, and writes nothing", async () => {
    await Promise.all(
      Array.from({ length: OUTBOX_MAX_PENDING }, (_, i) =>
        writeFile(join(dir, `${i}-1-abc.json`), "{}"),
      ),
    );
    const result = await fileReportFromProcess(
      { kind: "k", message: "m", data: {} },
      { dir },
    );
    expect(result).toEqual({ outcome: "refused", pending: OUTBOX_MAX_PENDING });
    expect(await readdir(dir)).toHaveLength(OUTBOX_MAX_PENDING);
  });

  test("never throws: a malformed report comes back as `failed`", async () => {
    const result = await fileReportFromProcess(
      {
        kind: "k",
        message: "m",
        data: {},
        code: { mergeBase: MERGE_BASE, paths: ["/absolute/path.ts"] },
      },
      { dir },
    );
    expect(result.outcome).toBe("failed");
    expect(await readdir(dir)).toHaveLength(0);
  });

  test("never throws: an unwritable directory comes back as `failed`", async () => {
    const file = join(dir, "not-a-dir");
    await writeFile(file, "");
    const result = await fileReportFromProcess(
      { kind: "k", message: "m", data: {} },
      { dir: join(file, "outbox") },
    );
    expect(result.outcome).toBe("failed");
  });
});

describe("fileReportFromProcessSync", () => {
  test("the entry is in place when it returns, stamped with the given repo", async () => {
    const result = fileReportFromProcessSync(
      { kind: "fatal-kind", message: "exiting", data: { why: "x" } },
      { dir: asAppPath(dir), repo: "/repos/one", now: 99 },
    );
    expect(result.outcome).toBe("written");
    const names = await readdir(dir);
    expect(names).toHaveLength(1);
    const name = names[0] ?? "";
    expect(isOutboxEntryName(name)).toBe(true);
    const entry = OutboxEntrySchema.parse(
      JSON.parse(await readFile(join(dir, name), "utf8")),
    );
    expect(entry).toMatchObject({
      kind: "fatal-kind",
      message: "exiting",
      data: { why: "x" },
      occurredAt: 99,
      writer: { pid: process.pid, repo: "/repos/one" },
    });
  });

  test("an unknown repo leaves the stamp out", async () => {
    fileReportFromProcessSync(
      { kind: "k", message: "m", data: {} },
      { dir: asAppPath(dir), repo: undefined },
    );
    const [name = ""] = await readdir(dir);
    const entry = OutboxEntrySchema.parse(
      JSON.parse(await readFile(join(dir, name), "utf8")),
    );
    expect(entry.writer.repo).toBeUndefined();
  });

  test("refuses at the cap and never throws on an unwritable directory", async () => {
    await Promise.all(
      Array.from({ length: OUTBOX_MAX_PENDING }, (_, i) =>
        writeFile(join(dir, `${i}-1-abc.json`), "{}"),
      ),
    );
    expect(
      fileReportFromProcessSync(
        { kind: "k", message: "m", data: {} },
        { dir: asAppPath(dir), repo: undefined },
      ),
    ).toEqual({ outcome: "refused", pending: OUTBOX_MAX_PENDING });
    const file = join(dir, "0-1-abc.json");
    expect(
      fileReportFromProcessSync(
        { kind: "k", message: "m", data: {} },
        { dir: asAppPath(join(file, "outbox")), repo: undefined },
      ).outcome,
    ).toBe("failed");
  });
});
