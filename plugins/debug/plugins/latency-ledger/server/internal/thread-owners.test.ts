import { describe, expect, test } from "bun:test";
import type { StackSample } from "@plugins/infra/plugins/stack-sampler/core";
import {
  npmOwnerOf,
  ownerOfSample,
  pluginOwnerOf,
  samplePeriodMs,
} from "./thread-owners";

const frame = (sourceURL: string | null) => ({
  name: "f",
  sourceURL,
  line: 1,
  column: 1,
  category: "FTL",
});
const sample = (urls: (string | null)[], timestamp = 0): StackSample => ({
  timestamp,
  frames: urls.map(frame),
  atMs: null,
  activity: null,
});

describe("thread owners", () => {
  test("names the deepest plugin of a repo path", () => {
    expect(
      pluginOwnerOf(
        "/r/plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts",
      ),
    ).toBe("conversations/runtime-tmux");
    expect(pluginOwnerOf("/r/plugins/tasks/server/index.ts")).toBe("tasks");
    expect(pluginOwnerOf("/r/cli/index.ts")).toBeNull();
  });

  test("a package under node_modules is never mistaken for a plugin", () => {
    const url =
      "/r/node_modules/.bun/pg@8.20.0+52bd/node_modules/pg/lib/client.js";
    expect(pluginOwnerOf(url)).toBeNull();
    expect(npmOwnerOf(url)).toBe("npm:pg");
    expect(
      npmOwnerOf(
        "/r/node_modules/.bun/x/node_modules/@parcel/watcher/index.js",
      ),
    ).toBe("npm:@parcel/watcher");
  });

  test("the first repo frame wins over the npm frames beneath it", () => {
    expect(
      ownerOfSample(
        sample([
          "/r/node_modules/.bun/zod@3/node_modules/zod/v3/types.js",
          "/r/plugins/infra/plugins/jobs/server/internal/worker.ts",
        ]),
      ),
    ).toBe("infra/jobs");
  });

  test("falls back to the npm package, then to native", () => {
    expect(
      ownerOfSample(
        sample([null, "/r/node_modules/.bun/pg@8/node_modules/pg/lib/x.js"]),
      ),
    ).toBe("npm:pg");
    expect(ownerOfSample(sample([null]))).toBe("native");
  });

  test("the period is the median gap, and unknown for a handful of samples", () => {
    expect(
      samplePeriodMs([sample([null], 0), sample([null], 0.004)]),
    ).toBeNull();
    const many = Array.from({ length: 20 }, (_, i) =>
      sample([null], i * 0.004),
    );
    expect(samplePeriodMs(many)).toBeCloseTo(4, 5);
  });
});
