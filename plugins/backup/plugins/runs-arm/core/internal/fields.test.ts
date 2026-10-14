/**
 * The Backup arm's fields, derived from its `liveArm`: the ids the runs
 * surface's saved views and filter presets name (`<kind>.<field>`) are
 * unchanged, and they are listed under the arm's "Backup" band.
 *
 * Run: `./singularity test plugins/backup/plugins/runs-arm`.
 */

import { describe, expect, test } from "bun:test";
import { backupRunArm } from "./fields";

describe("Backup arm fields", () => {
  test("lists the persisted field ids, in order, under its label", () => {
    expect(Object.keys(backupRunArm.listed)).toEqual([
      "backup.status",
      "backup.archiveSize",
      "backup.sourceCount",
      "backup.targetCount",
    ]);
    expect(backupRunArm.label).toBe("Backup");
  });
});
