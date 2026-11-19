import { describe, expect, test } from "bun:test";
import { EndpointNetworkError } from "@plugins/infra/plugins/endpoints/core";
import { FetchRequestError } from "@plugins/primitives/plugins/networking/plugins/request-guard/core";
import type { HostReach } from "@plugins/infra/plugins/health/web";
import { fileUnlessOffline, isFetchNoAnswer } from "./fetch-no-answer";

const ANSWERED: HostReach = { kind: "answered", status: 200, health: null };
const NO_ANSWER: HostReach = { kind: "no-answer" };

async function filed(err: unknown, reach: HostReach | "unasked") {
  let n = 0;
  let asked = false;
  await fileUnlessOffline(
    err,
    () => {
      n += 1;
    },
    () => {
      asked = true;
      if (reach === "unasked") throw new Error("must not probe");
      return Promise.resolve(reach);
    },
  );
  return { filed: n === 1, asked };
}

describe("isFetchNoAnswer", () => {
  test("an endpoint request with no answer", () => {
    expect(
      isFetchNoAnswer(
        new EndpointNetworkError(
          "POST /api/analytics/collect",
          new TypeError("Failed to fetch"),
        ),
      ),
    ).toBe(true);
  });

  test("each browser's bare fetch failure", () => {
    for (const message of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "The network connection was lost.",
      "The Internet connection appears to be offline.",
    ])
      expect(isFetchNoAnswer(new TypeError(message))).toBe(true);
  });

  test("a page fetch named by the request guard, by the browser's own words", () => {
    const named = (words: string) =>
      new FetchRequestError("GET", "/x", words, new TypeError(words));
    expect(
      isFetchNoAnswer(named("NetworkError when attempting to fetch resource.")),
    ).toBe(true);
    expect(isFetchNoAnswer(named("Failed to parse URL from ::"))).toBe(false);
  });

  test("any other TypeError, or a non-TypeError with the same words, is not one", () => {
    expect(isFetchNoAnswer(new TypeError("x is undefined"))).toBe(false);
    expect(isFetchNoAnswer(new Error("Failed to fetch"))).toBe(false);
    expect(isFetchNoAnswer("Failed to fetch")).toBe(false);
  });
});

describe("fileUnlessOffline", () => {
  test("a fetch with no answer on a host that answers is filed (the request is wrong)", async () => {
    expect(await filed(new TypeError("Failed to fetch"), ANSWERED)).toEqual({
      filed: true,
      asked: true,
    });
  });

  test("a fetch with no answer on a host that does not answer is not filed (the visitor's network)", async () => {
    expect(
      await filed(
        new TypeError("NetworkError when attempting to fetch resource."),
        NO_ANSWER,
      ),
    ).toEqual({ filed: false, asked: true });
  });

  test("every other rejection is filed without asking the host", async () => {
    expect(await filed(new TypeError("x is undefined"), "unasked")).toEqual({
      filed: true,
      asked: false,
    });
    expect(await filed(undefined, "unasked")).toEqual({
      filed: true,
      asked: false,
    });
  });
});
