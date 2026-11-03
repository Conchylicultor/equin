import { describe, expect, it } from "bun:test";
import { isRowUnknown } from "@plugins/network/plugins/live/core";
import { releaseAnswerOf, type ReleaseInfo } from "./use-release-info";

const refetch = () => Promise.resolve();

describe("releaseAnswerOf — a row's Release value is never a stand-in", () => {
  it("is pending until the row's probe answers", () => {
    const unasked = releaseAnswerOf(undefined);
    expect(isRowUnknown(unasked) && unasked.state).toEqual({
      status: "loading",
    });
    const loading = releaseAnswerOf({ status: "loading", refetch });
    expect(isRowUnknown(loading) && loading.state).toEqual({
      status: "loading",
    });
  });

  it("a failed probe is the failure, with its Retry — not a null", () => {
    const error = new Error("ssh refused");
    const info = { status: "error", error, refetch } as unknown as ReleaseInfo;
    const answer = releaseAnswerOf(info);
    if (!isRowUnknown(answer) || answer.state.status !== "error") {
      throw new Error(`expected a failed row, got ${String(answer)}`);
    }
    expect(answer.state.error.message).toBe("ssh refused");
    expect(answer.state.refetch).toBe(refetch);
  });

  it("a settled no-platform answer is a known null", () => {
    expect(
      releaseAnswerOf({
        status: "ready",
        data: { kind: "no-platform" },
        refetch,
      }),
    ).toBeNull();
  });
});
