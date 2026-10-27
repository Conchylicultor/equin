import { expect, test } from "bun:test";
import {
  CONFORMANCE_ROOT,
  describeDataFilesConformance,
} from "@plugins/infra/plugins/paths/plugins/data-files/server/testing";
import { parseRelPath } from "@plugins/infra/plugins/paths/plugins/data-files/core";
import { systemOrigin } from "@plugins/infra/plugins/request-origin/core";
import { createMemoryDataFiles } from "./memory-store";

describeDataFilesConformance("memory", async () => ({
  store: createMemoryDataFiles(),
  dispose: async () => undefined,
}));

const w = { writer: systemOrigin("memory-store test") };

test("two writes in one millisecond still move the mtime", async () => {
  const s = createMemoryDataFiles().root(CONFORMANCE_ROOT);
  await s.write(parseRelPath("a.txt"), "1", w);
  const before = await s.stat(parseRelPath("a.txt"));
  await s.write(parseRelPath("a.txt"), "2", w);
  const after = await s.stat(parseRelPath("a.txt"));
  if (before.kind !== "found" || after.kind !== "found")
    throw new Error("missing");
  expect(after.entry.mtimeMs).toBeGreaterThan(before.entry.mtimeMs);
  expect(after.entry.birthtimeMs).toBe(before.entry.birthtimeMs);
});

test("one microtask's mutations reach a subscriber as one change", async () => {
  const s = createMemoryDataFiles().root(CONFORMANCE_ROOT);
  const seen: unknown[] = [];
  const sub = await s.watch((change) => {
    seen.push(change);
  });
  await Promise.all([
    s.write(parseRelPath("a.txt"), "a", w),
    s.write(parseRelPath("b.txt"), "b", w),
  ]);
  await Promise.resolve();
  await sub.dispose();
  expect(seen).toEqual([{ kind: "changed", paths: ["a.txt", "b.txt"] }]);
});
