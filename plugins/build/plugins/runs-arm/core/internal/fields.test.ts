/**
 * The Build arm's fields, derived from its `liveArm`: the ids the runs
 * surface's saved views and filter presets name (`<kind>.<field>`) are
 * unchanged, and they are listed under the arm's "Build" band.
 *
 * Run: `./singularity test plugins/build/plugins/runs-arm`.
 */

import { describe, expect, test } from "bun:test";
import { buildRunArm } from "./fields";

describe("Build arm fields", () => {
  test("lists the persisted field ids, in order, under its label", () => {
    expect(Object.keys(buildRunArm.listed)).toEqual([
      "build.status",
      "build.targets",
      "build.commitHash",
      "build.exitCode",
    ]);
    expect(buildRunArm.label).toBe("Build");
  });
});
