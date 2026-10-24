import { describe, expect, test } from "bun:test";
import type { GatewayDrift } from "../../core";
import { gatewayVerdict } from "./gateway-health";

const refetch = async () => {};
const ready = (data: GatewayDrift) =>
  gatewayVerdict({ status: "ready", data, refetch });

describe("gatewayVerdict", () => {
  test("loading is unknown, never ok", () => {
    expect(gatewayVerdict({ status: "loading", refetch })).toEqual({
      state: "unknown",
    });
  });

  test("stale names each difference and the command", () => {
    expect(
      ready({
        kind: "stale",
        differences: ["-listen :9000 → loopback:9000", "new -pid-file"],
      }),
    ).toEqual({
      state: "attention",
      summary:
        "Out of date (-listen :9000 → loopback:9000; new -pid-file) — run ./equin start --force",
    });
  });

  test("current is ok", () => {
    expect(ready({ kind: "current" }).state).toBe("ok");
  });

  test("not applicable here, or no computer: out of the merge", () => {
    expect(ready({ kind: "not-applicable", reason: "A release" })).toEqual({
      state: "not-applicable",
      summary: "A release",
    });
    expect(
      gatewayVerdict({ status: "unavailable", message: "Not here." }),
    ).toEqual({ state: "not-applicable", summary: "Not here." });
  });

  test("an unreadable check is unknown with why", () => {
    expect(ready({ kind: "unreadable", message: "boom" })).toEqual({
      state: "unknown",
      summary: "Couldn't compare the gateway: boom",
    });
  });
});
