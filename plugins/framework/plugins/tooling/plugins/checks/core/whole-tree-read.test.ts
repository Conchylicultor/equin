import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "@plugins/packages/plugins/timed-fs/core";
import { sharedWork } from "@plugins/packages/plugins/shared-work/core";
import { WHOLE_TREE_FILE_CALLS } from "@plugins/framework/plugins/tooling/core";
import { judgeOwnFileCalls, meterOwnFileCalls } from "./whole-tree-read";

const dir = mkdtempSync(join(tmpdir(), "whole-tree-read-"));
writeFileSync(join(dir, "a.txt"), "a");
const file = join(dir, "a.txt");

async function reads(n: number): Promise<void> {
  await Promise.all(Array.from({ length: n }, () => readFile(file, "utf8")));
}

const OVER = WHOLE_TREE_FILE_CALLS + 1;

describe("a check body's own file calls against its declaration", () => {
  it("an undeclared body over the bound fails, naming its count", async () => {
    const { result, own } = await meterOwnFileCalls(async () => {
      await reads(OVER);
      return { ok: true };
    });
    const judged = judgeOwnFileCalls({ id: "x" }, own, result);
    expect(judged.ok).toBe(false);
    if (!judged.ok) expect(judged.message).toContain(`${OVER} file calls`);
  });

  it("a declared body over the bound passes", async () => {
    const { result, own } = await meterOwnFileCalls(async () => {
      await reads(OVER);
      return { ok: true };
    });
    const check = {
      id: "x",
      wholeTreeRead: { kind: "debt", task: "task-1", reason: "r" },
    } as const;
    expect(judgeOwnFileCalls(check, own, result)).toEqual({ ok: true });
  });

  it("a declaration whose body stays under the bound fails: it outlived its read", async () => {
    const { result, own } = await meterOwnFileCalls(async () => {
      await reads(3);
      return { ok: true };
    });
    const check = {
      id: "x",
      wholeTreeRead: { kind: "sanctioned", reason: "r" },
    } as const;
    expect(judgeOwnFileCalls(check, own, result).ok).toBe(false);
  });

  it("a declared body just under the bound is not stale: no flip near the line", async () => {
    const { result, own } = await meterOwnFileCalls(async () => {
      await reads(WHOLE_TREE_FILE_CALLS - 10);
      return { ok: true };
    });
    const check = {
      id: "x",
      wholeTreeRead: { kind: "debt", task: "task-1", reason: "r" },
    } as const;
    expect(judgeOwnFileCalls(check, own, result)).toEqual({ ok: true });
  });

  it("shared work is no body's own, whichever body starts it", async () => {
    let memo: Promise<void> | null = null;
    const shared = () =>
      (memo ??= sharedWork("whole-tree-read test", () => reads(OVER)));
    for (let i = 0; i < 2; i++) {
      const { result, own } = await meterOwnFileCalls(async () => {
        await shared();
        return { ok: true };
      });
      expect(own.total).toBe(0);
      expect(judgeOwnFileCalls({ id: "x" }, own, result)).toEqual({ ok: true });
    }
  });

  it("an inconclusive run is not judged", async () => {
    const { result, own } = await meterOwnFileCalls(async () => {
      await reads(OVER);
      return { ok: false, message: "m", inconclusive: true } as const;
    });
    expect(judgeOwnFileCalls({ id: "x" }, own, result)).toBe(result);
  });

  it("a failing undeclared body keeps its own message and gains the count", async () => {
    const { result, own } = await meterOwnFileCalls(async () => {
      await reads(OVER);
      return { ok: false, message: "own failure" } as const;
    });
    const judged = judgeOwnFileCalls({ id: "x" }, own, result);
    expect(judged.ok).toBe(false);
    if (!judged.ok) {
      expect(judged.message).toStartWith("own failure\n");
      expect(judged.message).toContain("whole-tree read");
    }
  });
});
