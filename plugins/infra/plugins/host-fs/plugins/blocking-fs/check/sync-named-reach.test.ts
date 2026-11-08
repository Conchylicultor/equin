import { describe, expect, test } from "bun:test";
import type { ResolvedExemption } from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import { backendReach, syncNamedReachViolations } from "./sync-named-reach";

const FILES: Record<string, string> = {
  "plugins/audience/server/index.ts": `import { x } from "@plugins/fullscreen/core";\nimport type { T } from "@plugins/hints/core";\nexport const y = () => import("@plugins/ids/core");`,
  "plugins/audience/server/a.test.ts": `import { t } from "@plugins/history/core";`,
  "plugins/fullscreen/core/index.ts": `export { x } from "./internal/x";`,
  "plugins/fullscreen/core/internal/x.ts": `export const x = 1;`,
  "plugins/hints/core/index.ts": `export type T = number;`,
  "plugins/ids/core/index.ts": `export const d = 1;`,
  "plugins/history/core/index.ts": `export const t = 1;`,
};
const scan = {
  paths: Object.keys(FILES),
  read: (p: string) => Promise.resolve(FILES[p] ?? null),
};

const sanctioned = (target: string): ResolvedExemption => ({
  rule: "blocking-fs/sync-named",
  plugin: target.split("/")[1]!,
  manifest: `plugins/${target.split("/")[1]!}/exempt/index.ts`,
  path: "core",
  target,
  kind: "sanctioned",
  reason: "host tooling only",
});

describe("backendReach", () => {
  test("follows runtime and dynamic imports from backend modules, not type-only ones or tests", async () => {
    const reach = await backendReach(scan);
    expect([...reach.keys()].sort()).toEqual([
      "plugins/audience/server/index.ts",
      "plugins/fullscreen/core/index.ts",
      "plugins/fullscreen/core/internal/x.ts",
      "plugins/ids/core/index.ts",
    ]);
    expect(reach.get("plugins/fullscreen/core/internal/x.ts")).toBe(
      "plugins/fullscreen/core/index.ts",
    );
  });
});

describe("syncNamedReachViolations", () => {
  test("a sanctioned exemption on a module a backend loads is a violation, with its chain", async () => {
    const violations = await syncNamedReachViolations({
      ...scan,
      exemptions: [
        sanctioned("plugins/fullscreen/core"),
        sanctioned("plugins/history/core"),
      ],
    });
    expect(violations.map((v) => [v.module, v.chain])).toEqual([
      [
        "plugins/fullscreen/core/index.ts",
        [
          "plugins/audience/server/index.ts",
          "plugins/fullscreen/core/index.ts",
        ],
      ],
      [
        "plugins/fullscreen/core/internal/x.ts",
        [
          "plugins/audience/server/index.ts",
          "plugins/fullscreen/core/index.ts",
          "plugins/fullscreen/core/internal/x.ts",
        ],
      ],
    ]);
  });

  test("a debt exemption makes no claim", async () => {
    const debt = {
      ...sanctioned("plugins/fullscreen/core"),
      kind: "debt" as const,
      task: "task-x",
    };
    expect(
      await syncNamedReachViolations({ ...scan, exemptions: [debt] }),
    ).toEqual([]);
  });
});
