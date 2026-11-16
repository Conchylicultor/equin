import { describe, expect, test } from "bun:test";
import { FILE_KIND_IDS, FILE_KINDS, fileKindOf } from "./file-kind";

describe("fileKindOf", () => {
  test.each([
    ["plugins/tasks/core/x.ts", "code"],
    ["gateway/main.go", "code"],
    ["plugins/tasks/web/x.tsx", "code"],
    ["plugins/tasks/core/x.test.ts", "test"],
    ["plugins/tasks/web/__tests__/x.test.tsx", "test"],
    ["gateway/principal_test.go", "test"],
    ["plugins/tasks/CLAUDE.md", "doc"],
    ["research/2026-11-16-x.md", "doc"],
    ["README.MD", "doc"],
    ["docs/plugins-details.md", "generated"],
    ["plugins/tasks/REFERENCE.md", "generated"],
    ["plugins/tasks/core/web.generated.ts", "generated"],
    ["config/a/b.origin.jsonc", "generated"],
    ["plugins/database/plugins/migrations/data/0001_x.sql", "generated"],
  ] as const)("%s → %s", (path, kind) => {
    expect(fileKindOf(path)).toBe(kind);
  });

  test("FILE_KINDS covers every id, in order", () => {
    expect(Object.keys(FILE_KINDS)).toEqual([...FILE_KIND_IDS]);
  });
});
