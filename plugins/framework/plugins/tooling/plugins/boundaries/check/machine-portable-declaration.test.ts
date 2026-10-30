import { describe, expect, test } from "bun:test";
import {
  misplacedMachineDeclarations,
  portableDeclarationsIn,
} from "./machine-portable-declaration";

const RETENTION = "@plugins/infra/plugins/retention/server";
const WARMUP = "@plugins/infra/plugins/warmup/server";

describe("portableDeclarationsIn", () => {
  test("reads retention and warm-up declarations, aliases included", () => {
    const src = [
      `import { defineRetention, markCascadeBounded as bound } from "${RETENTION}";`,
      `import { defineWarmup } from "${WARMUP}";`,
    ].join("\n");
    expect(portableDeclarationsIn(src)).toEqual([
      "defineRetention",
      "defineWarmup",
      "markCascadeBounded",
    ]);
  });

  test("a type-only import declares nothing", () => {
    const src = [
      `import type { defineRetention } from "${RETENTION}";`,
      `import { type defineWarmup } from "${WARMUP}";`,
    ].join("\n");
    expect(portableDeclarationsIn(src)).toEqual([]);
  });

  test("other names from the same barrels, and other barrels, are ignored", () => {
    const src = [
      `import { getTableGrowthBounds } from "${RETENTION}";`,
      `import { defineRetention } from "@plugins/other/server";`,
      `import { defineJob } from "@plugins/infra/plugins/jobs/server";`,
    ].join("\n");
    expect(portableDeclarationsIn(src)).toEqual([]);
  });

  test("a re-export declares nothing", () => {
    const src = [
      `export { defineRetention } from "${RETENTION}";`,
      `export * from "${WARMUP}";`,
    ].join("\n");
    expect(portableDeclarationsIn(src)).toEqual([]);
  });

  test("a namespace import counts as every name of its barrel", () => {
    const src = `import * as warmup from "${WARMUP}";`;
    expect(portableDeclarationsIn(src)).toEqual(["defineWarmup"]);
  });
});

describe("misplacedMachineDeclarations", () => {
  const DECLARES = `import { defineRetention } from "${RETENTION}";`;
  const files: Record<string, string> = {
    "plugins/audience/machine/internal/sweep.ts": DECLARES,
    "plugins/apps/plugins/pages/plugins/agent-origin/machine/index.ts":
      DECLARES,
    "plugins/fullscreen/machine/internal/sweep.test.ts": DECLARES,
    "plugins/hints/server/internal/sweep.ts": DECLARES,
    "plugins/ids/machine/internal/plain.ts": `import { defineJob } from "@plugins/infra/plugins/jobs/server";`,
    "plugins/wish/machine/internal/sweep.ts": DECLARES,
  };
  const scan = (opts: { platform?: string[]; exempt?: string[] }) =>
    misplacedMachineDeclarations({
      paths: Object.keys(files),
      read: (p) => Promise.resolve(files[p] ?? null),
      reachesPlatform: (m) =>
        Promise.resolve(opts.platform?.includes(m) ?? false),
      skips: (m) => opts.exempt?.includes(m) ?? false,
    });

  test("reports each non-test machine/ declarer whose closure is clean", async () => {
    expect(await scan({})).toEqual([
      "plugins/audience/machine/internal/sweep.ts declares defineRetention and its closure reaches no platform API",
      "plugins/apps/plugins/pages/plugins/agent-origin/machine/index.ts declares defineRetention and its closure reaches no platform API",
      "plugins/wish/machine/internal/sweep.ts declares defineRetention and its closure reaches no platform API",
    ]);
  });

  test("a declarer whose closure reaches a platform API, or a sanctioned one, passes", async () => {
    const failures = await scan({
      platform: ["plugins/audience/machine/internal/sweep.ts"],
      exempt: ["plugins/wish/machine/internal/sweep.ts"],
    });
    expect(failures).toEqual([
      "plugins/apps/plugins/pages/plugins/agent-origin/machine/index.ts declares defineRetention and its closure reaches no platform API",
    ]);
  });
});
