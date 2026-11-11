import { describe, expect, it } from "bun:test";
import { ResourceError } from "@plugins/network/plugins/live/plugins/live-state/core";
import { throwContractRefusal } from "./refusals";

function refused(code: string) {
  return {
    status: "error" as const,
    error: new ResourceError("refused", `refused ${code}`, undefined, code),
  };
}

describe("throwContractRefusal", () => {
  it("lets a hash-behind refusal pass: the read re-keys on the new hash", () => {
    expect(() => throwContractRefusal(refused("stale-manifest"))).not.toThrow();
    expect(() => throwContractRefusal(refused("stale-symbols"))).not.toThrow();
  });

  it("throws a contract refusal", () => {
    expect(() => throwContractRefusal(refused("unknown-key"))).toThrow(
      "refused unknown-key",
    );
    expect(() => throwContractRefusal(refused("invalid-names"))).toThrow();
  });

  it("passes every other state", () => {
    expect(() => throwContractRefusal(undefined)).not.toThrow();
    expect(() => throwContractRefusal({ status: "loading" })).not.toThrow();
    expect(() => throwContractRefusal({ status: "ready" })).not.toThrow();
    expect(() =>
      throwContractRefusal({
        status: "error",
        error: new ResourceError("transport", "offline", undefined),
      }),
    ).not.toThrow();
  });
});
