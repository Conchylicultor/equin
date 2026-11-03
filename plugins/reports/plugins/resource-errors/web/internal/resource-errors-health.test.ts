/** The Live reads health row's verdict over the page's failing reads. */

import { describe, expect, test } from "bun:test";
import { ResourceError } from "@plugins/network/plugins/live/plugins/live-state/core";
import { resourceErrorsVerdict } from "./resource-errors-health";

const failing = (
  key: string,
  kind: ResourceError["kind"],
  message: string,
) => ({
  key,
  params: {},
  error: new ResourceError(kind, message, null),
});

describe("resourceErrorsVerdict", () => {
  test("ok while nothing fails", () => {
    expect(resourceErrorsVerdict([]).state).toBe("ok");
  });

  test("attention naming the count and the first failure", () => {
    expect(
      resourceErrorsVerdict([
        failing("build.history", "loader-failed", "boom"),
        failing("tasks", "transport", "offline"),
      ]),
    ).toEqual({
      state: "attention",
      summary: "2 resources failing: build.history — boom (and 1 more)",
    });
  });

  test("an out-of-date tab points at the reload", () => {
    expect(
      resourceErrorsVerdict([
        failing("build.history", "client-outdated", "outdated"),
      ]),
    ).toEqual({
      state: "attention",
      summary: "1 resource failing — this tab is out of date; reload to fix",
    });
  });
});
