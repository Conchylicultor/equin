import { describe, expect, test } from "bun:test";
import type { ResolvedExemption } from "@plugins/framework/plugins/tooling/plugins/exempt/core";
import { backendModules, syncNamedReachViolations } from "./sync-named-reach";

// What the module graph answers for the run's backend modules: each reached
// module and who first reached it (the reading itself is plugin-records'
// `fileSetRuntimeReach`, tested there).
const PATHS = [
  "plugins/audience/server/index.ts",
  "plugins/audience/server/a.test.ts",
  "plugins/fullscreen/core/index.ts",
  "plugins/fullscreen/core/internal/x.ts",
  "plugins/history/core/index.ts",
];
const REACH = new Map<string, string | null>([
  ["plugins/audience/server/index.ts", null],
  ["plugins/fullscreen/core/index.ts", "plugins/audience/server/index.ts"],
  ["plugins/fullscreen/core/internal/x.ts", "plugins/fullscreen/core/index.ts"],
]);
const asked: string[][] = [];
const scan = {
  paths: PATHS,
  reach: (entries: readonly string[]) => {
    asked.push([...entries]);
    return Promise.resolve(REACH);
  },
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

describe("backendModules", () => {
  test("backend runtime modules only, test code aside", () => {
    expect(backendModules(PATHS)).toEqual(["plugins/audience/server/index.ts"]);
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
    expect(asked.at(-1)).toEqual(["plugins/audience/server/index.ts"]);
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
