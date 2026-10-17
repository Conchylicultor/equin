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
      // The picks from the entity first, in pick order, then the arm's own.
      "build.targets",
      "build.commitHash",
      "build.exitCode",
      "build.status",
    ]);
    expect(buildRunArm.label).toBe("Build");
  });

  test("picks its stored fields from the build-run entity, with its labels", () => {
    expect(buildRunArm.reaches?.name).toBe("build_runs");
    expect(buildRunArm.picked).toEqual(["targets", "commitHash", "exitCode"]);
    expect(buildRunArm.listed["build.commitHash"]?.label).toBe("Commit");
  });
});
