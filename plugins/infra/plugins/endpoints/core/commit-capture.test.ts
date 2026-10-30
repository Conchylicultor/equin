import { afterEach, describe, expect, test } from "bun:test";
import { defineEndpoint } from "./define-endpoint";
import { brandEndpointEffect } from "./endpoint-effect";
import {
  COMMITS_HEADER,
  installCommitCapture,
  isTransactionId,
  mintExternalWriteId,
  readCommitsHeader,
  type CommitCapture,
} from "./commit-capture";
import { implement } from "./implement";

// The commit ack of a predicted write: `implement` runs a predicted
// endpoint's handler under the installed capture and stamps the transactions
// it committed on the response — the handler opts into nothing.

const req = () => new Request("http://localhost/api/thing", { method: "POST" });

/** A capture answering `commits` for every run, counting its runs. */
function fakeCapture(commits: readonly string[]) {
  const state = { runs: 0 };
  const capture: CommitCapture = {
    async run(fn) {
      state.runs += 1;
      return { value: await fn(), commits };
    },
  };
  return { capture, state };
}

const passthrough: CommitCapture = {
  run: async (fn) => ({ value: await fn(), commits: [] }),
};

const predicted = defineEndpoint({
  route: "POST /api/thing/predicted",
  effect: () => brandEndpointEffect({}),
});
const unpredicted = defineEndpoint({
  route: "POST /api/thing/unpredicted",
  unpredicted: { reason: "response", why: "test fixture" },
});

describe("commit capture", () => {
  afterEach(() => installCommitCapture(passthrough));

  test("a predicted write's response names its commits, a void one included", async () => {
    const { capture, state } = fakeCapture(["10", "12"]);
    installCommitCapture(capture);
    const res = await implement(predicted, () => undefined)(req(), {});
    expect(res.status).toBe(204);
    expect(res.headers.get(COMMITS_HEADER)).toBe("10,12");
    expect(readCommitsHeader(res)).toEqual(["10", "12"]);
    expect(state.runs).toBe(1);
  });

  test("no commit, no header", async () => {
    installCommitCapture(fakeCapture([]).capture);
    const res = await implement(predicted, () => undefined)(req(), {});
    expect(res.headers.has(COMMITS_HEADER)).toBe(false);
    expect(readCommitsHeader(res)).toEqual([]);
  });

  test("an unpredicted write never runs under the capture", async () => {
    const { capture, state } = fakeCapture(["10"]);
    installCommitCapture(capture);
    const res = await implement(unpredicted, () => undefined)(req(), {});
    expect(res.headers.has(COMMITS_HEADER)).toBe(false);
    expect(state.runs).toBe(0);
  });

  test("an external write id rides the header beside the transactions, and is no transaction", () => {
    const a = mintExternalWriteId();
    const b = mintExternalWriteId();
    expect(a).not.toBe(b);
    const res = new Response(null, {
      headers: { [COMMITS_HEADER]: `10,${a}` },
    });
    expect(readCommitsHeader(res)).toEqual(["10", a]);
    expect(isTransactionId("10")).toBe(true);
    expect(isTransactionId(a)).toBe(false);
  });

  test("a garbled header is a server bug, read loudly", () => {
    const res = new Response(null, { headers: { [COMMITS_HEADER]: "1,x" } });
    expect(() => readCommitsHeader(res)).toThrow(/transaction ids/);
  });
});
