import { describe, expect, test } from "bun:test";
import { isGeneratedArtifactPath } from "./generated-artifacts";

describe("isGeneratedArtifactPath", () => {
  test.each([
    "docs/plugins-details.md",
    "docs/routes.md",
    "plugins/tasks/REFERENCE.md",
    "plugins/tasks/plugins/task-list/REFERENCE.md",
    "plugins/framework/plugins/web-sdk/core/web.generated.ts",
    "./plugins/x/core/y.generated.ts",
    "config/a/b.origin.jsonc",
    "plugins/database/plugins/migrations/data/0042_x.sql",
    "plugins/database/plugins/migrations/data/meta/_journal.json",
    "plugins/database/plugins/migrations/data/meta/0042_snapshot.json",
  ])("%s is generated", (p) => {
    expect(isGeneratedArtifactPath(p)).toBe(true);
  });

  test.each([
    "docs/other.md",
    "plugins/tasks/CLAUDE.md",
    "plugins/tasks/core/x.ts",
    "web/x.generated.ts",
    "plugins/database/plugins/migrations/data/meta/x.json",
    "plugins/database/plugins/migrations/data/sub/x.sql",
    "plugins/tasks/REFERENCEXmd",
  ])("%s is not", (p) => {
    expect(isGeneratedArtifactPath(p)).toBe(false);
  });
});
