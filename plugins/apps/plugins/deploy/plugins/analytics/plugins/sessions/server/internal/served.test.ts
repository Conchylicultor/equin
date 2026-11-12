import { describe, expect, test } from "bun:test";
import { and, clause } from "@plugins/network/plugins/live/plugins/filter/core";
import { splitScope } from "./served";

describe("splitScope", () => {
  const site = clause("deploymentId", "eq", "dpl-1");
  const owner = clause("owner", "eq", false);
  const since = clause("startedAt", "gte", "2026-11-01T00:00:00.000Z");

  test("the site alone, or beside the rest of the filter", () => {
    expect(splitScope(site)).toEqual({
      deploymentId: "dpl-1",
      where: undefined,
    });
    expect(splitScope(and(site, owner))).toEqual({
      deploymentId: "dpl-1",
      where: owner,
    });
    expect(splitScope(and(site, owner, since))).toEqual({
      deploymentId: "dpl-1",
      where: and(owner, since),
    });
  });

  test("a read naming no site, or two, has no spelling", () => {
    expect(() => splitScope(undefined)).toThrow(/names one site/);
    expect(() => splitScope(owner)).toThrow(/names one site/);
    expect(() =>
      splitScope(and(site, clause("deploymentId", "eq", "dpl-2"))),
    ).toThrow(/names one site/);
  });
});
