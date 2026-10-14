/**
 * The deployment collections' derived fields: the ids the DataViews (and every
 * saved view) name are unchanged.
 *
 * Run: `./singularity test plugins/apps/plugins/deploy/plugins/deployments`.
 */

import { describe, expect, test } from "bun:test";
import { deployments } from "./resources";
import { deployRunHistory } from "./runs";

describe("deploy.run-history", () => {
  test("lists the History's fields, in order, plus the scope and sort-only ones", () => {
    expect(Object.keys(deployRunHistory.fields)).toEqual([
      "status",
      "verb",
      "commitSha",
      "releaseRunId",
      "startedAt",
      "message",
      "deploymentId",
      "finishedAt",
    ]);
  });

  test("labels, options and domains come from the declaration", () => {
    const f = deployRunHistory.fields;
    expect(f.status).toMatchObject({
      label: "Outcome",
      primary: true,
      sortable: true,
      domain: "text",
    });
    expect(Object.keys(f.status.options ?? {})).toEqual([
      "running",
      "succeeded",
      "failed",
    ]);
    expect(Object.keys(f.verb.options ?? {})).toEqual([
      "update",
      "converge",
      "ship",
    ]);
    expect(f.startedAt.domain).toBe("instant");
    expect(f.deploymentId.domain).toBe("text");
  });
});

describe("deploy.deployments", () => {
  test("filters by server; the record rides on the row", () => {
    expect(Object.keys(deployments.fields)).toEqual(["serverId"]);
    expect(deployments.fields.serverId.domain).toBe("text");
    expect([...deployments.rowKeys].map(String).sort()).toEqual(
      [
        "compositionId",
        "createdAt",
        "hostnames",
        "id",
        "loopbackPort",
        "serverId",
        "updatedAt",
      ].sort(),
    );
  });
});
