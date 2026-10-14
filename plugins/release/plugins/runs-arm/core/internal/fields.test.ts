/**
 * The Release arm's fields, derived from its `liveArm`: the ids the runs
 * surface's saved views and filter presets name (`<kind>.<field>`) are
 * unchanged, and they are listed under the arm's "Release" band.
 *
 * Run: `./singularity test plugins/release/plugins/runs-arm`.
 */

import { describe, expect, test } from "bun:test";
import { releaseRunArm } from "./fields";

describe("Release arm fields", () => {
  test("lists the persisted field ids, in order, under its label", () => {
    expect(Object.keys(releaseRunArm.listed)).toEqual([
      "release.kind",
      "release.composition",
      "release.target",
      "release.platform",
      "release.commitSha",
      "release.commitDirty",
      "release.artifactPath",
    ]);
    expect(releaseRunArm.label).toBe("Release");
  });
});
