import { describe, expect, test } from "bun:test";
import { platformTaint } from "../core/portability";
import { runsInBrowserRealm, webLoadViolations } from "./web-loads-portable";

describe("runsInBrowserRealm", () => {
  test.each([
    ["plugins/audience/web/index.ts", true],
    ["plugins/audience/plugins/settings/web/components/x.tsx", true],
    ["plugins/audience/exhibits/index.tsx", true],
    // A jsdom suite runs without the computer.
    ["plugins/audience/web/__tests__/x.test.tsx", true],
    // A bun:test file beside its source runs on Bun.
    ["plugins/audience/web/internal/x.test.ts", false],
    ["plugins/audience/core/index.ts", false],
    ["plugins/audience/shared/x.ts", false],
    // A plugin NAMED exhibits is not the exhibits folder.
    ["plugins/plugin-meta/plugins/exhibits/e2e/shot.ts", false],
  ])("%s → %p", (path, expected) => {
    expect(runsInBrowserRealm(path)).toBe(expected);
  });
});

describe("webLoadViolations", () => {
  // The fixture tree: web loads a clean core, a host-only core (through an
  // internal module that imports node:os) and its own shared, which loads the
  // host-only core in turn.
  const sources: Record<string, string> = {
    "plugins/audience/web/index.ts": [
      `import { clean } from "@plugins/fullscreen/core";`,
      `import type { Dir } from "@plugins/infra/plugins/paths/core";`,
      `import { helper } from "../shared/helper";`,
      `import { View } from "./view";`,
    ].join("\n"),
    "plugins/audience/web/view.tsx": `export const View = 1;`,
    "plugins/audience/web/__tests__/a.test.tsx": `import { HOME } from "@plugins/infra/plugins/paths/core";`,
    // bun:test: Node is there.
    "plugins/audience/web/internal/b.test.ts": `import { HOME } from "@plugins/infra/plugins/paths/core";`,
    "plugins/audience/shared/helper.ts": `import { HOME } from "@plugins/infra/plugins/paths/core";\nexport const helper = HOME;`,
    "plugins/fullscreen/core/index.ts": `export const clean = 1;`,
    "plugins/infra/plugins/paths/core/index.ts": `export { HOME } from "./internal/home";`,
    "plugins/infra/plugins/paths/core/internal/home.ts": `import { cpus } from "node:os";\nexport const HOME = cpus();\nexport const DIR = import.meta.dir;`,
  };
  const edges: Record<string, string[]> = {
    "plugins/fullscreen/core/index.ts": [],
    "plugins/audience/shared/helper.ts": [
      "plugins/infra/plugins/paths/core/index.ts",
    ],
    "plugins/infra/plugins/paths/core/index.ts": [
      "plugins/infra/plugins/paths/core/internal/home.ts",
    ],
    "plugins/infra/plugins/paths/core/internal/home.ts": [],
  };
  const read = (p: string): Promise<string | null> =>
    Promise.resolve(sources[p] ?? null);
  const closureOf = (entries: readonly string[]) => {
    const modules = new Set<string>();
    const walk = (m: string): void => {
      if (modules.has(m)) return;
      modules.add(m);
      for (const c of edges[m]!) walk(c);
    };
    for (const e of entries) walk(e);
    return { modules, children: (m: string) => edges[m]! };
  };

  test("reports each host-only frontier module with who loads it, type-only imports and bun:test files aside", async () => {
    const asked: string[][] = [];
    const violations = await webLoadViolations({
      paths: Object.keys(sources),
      read,
      taint: (entries) => {
        asked.push([...entries]);
        return platformTaint(closureOf(entries), read);
      },
      skips: () => false,
    });
    // The web-to-web import is read at view.tsx itself, never measured.
    expect(asked).toEqual([
      [
        "plugins/audience/shared/helper.ts",
        "plugins/fullscreen/core/index.ts",
        "plugins/infra/plugins/paths/core/index.ts",
      ],
    ]);
    expect(violations).toEqual([
      {
        module: "plugins/audience/shared/helper.ts",
        loadedBy: ["plugins/audience/web/index.ts"],
        offenders: [
          {
            module: "plugins/infra/plugins/paths/core/internal/home.ts",
            needs: ["node:os", "import.meta.dir"],
            chain: [
              "plugins/audience/shared/helper.ts",
              "plugins/infra/plugins/paths/core/index.ts",
              "plugins/infra/plugins/paths/core/internal/home.ts",
            ],
          },
        ],
      },
      {
        module: "plugins/infra/plugins/paths/core/index.ts",
        loadedBy: ["plugins/audience/web/__tests__/a.test.tsx"],
        offenders: [
          {
            module: "plugins/infra/plugins/paths/core/internal/home.ts",
            needs: ["node:os", "import.meta.dir"],
            chain: [
              "plugins/infra/plugins/paths/core/index.ts",
              "plugins/infra/plugins/paths/core/internal/home.ts",
            ],
          },
        ],
      },
    ]);
  });

  test("an exempted loader is not reported", async () => {
    const violations = await webLoadViolations({
      paths: Object.keys(sources),
      read,
      taint: (entries) => platformTaint(closureOf(entries), read),
      skips: (p) => p.includes("__tests__") || p.endsWith("index.ts"),
    });
    expect(violations).toEqual([]);
  });
});
