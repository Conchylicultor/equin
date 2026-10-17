/**
 * The Deploy arm's fields, derived from its `liveArm`: the ids the runs
 * surface's saved views and filter presets name (`<kind>.<field>`) are
 * unchanged, and they are listed under the arm's "Deploy" band.
 *
 * Run: `./singularity test plugins/apps/plugins/deploy/plugins/deployments/plugins/runs-arm`.
 */

import { describe, expect, test } from "bun:test";
import { deployRunArm } from "./fields";

describe("Deploy arm fields", () => {
  test("lists the persisted field ids, in order, under its label", () => {
    expect(Object.keys(deployRunArm.listed)).toEqual([
      "deploy.verb",
      "deploy.phaseFailed",
      "deploy.compositionId",
      "deploy.serverId",
      "deploy.deploymentId",
      "deploy.commitSha",
      "deploy.releaseRunId",
      "deploy.exitCode",
    ]);
    expect(deployRunArm.label).toBe("Deploy");
  });

  test("picks every field from the deploy-run entity, with its labels", () => {
    expect(deployRunArm.reaches?.name).toBe("deploy_runs");
    expect(deployRunArm.listed["deploy.releaseRunId"]?.label).toBe(
      "Release run",
    );
  });
});
