import { describe, expect, test } from "bun:test";
import type { SignalOrigin } from "@plugins/packages/plugins/signal-origin/core";
import type { SignalOriginLine } from "@plugins/packages/plugins/signal-origin/plugins/sink/core";
import { selectTermination } from "./select-termination";

const origin: SignalOrigin = {
  signal: 15,
  siCode: 1,
  senderPid: 41234,
  senderUid: 501,
  senderPath: "/bin/kill",
  ancestry: [
    { pid: 41234, ppid: 41198, uid: 501, comm: "kill" },
    { pid: 41198, ppid: 872, uid: 501, comm: "bun" },
  ],
  ancestryErrno: 0,
  selfPpid: 1,
  wallNs: "1786053763482000000",
  monoNs: "123456789",
  hits: 1,
};

function signalLine(
  buildId: string,
  over: Partial<SignalOriginLine> = {},
): SignalOriginLine {
  return {
    at: "2026-08-07T15:18:25.236Z",
    event: "signal",
    buildId,
    worktree: "att-1",
    signal: "SIGTERM",
    origin,
    ...over,
  } as SignalOriginLine;
}

describe("selectTermination", () => {
  test("an empty sink is an empty record, not a missing one", () => {
    expect(selectTermination([], "b1")).toEqual({
      signal: null,
      armFailure: null,
    });
  });

  test("a run nobody signalled stays empty even when other runs died", () => {
    expect(selectTermination([signalLine("other")], "b1")).toEqual({
      signal: null,
      armFailure: null,
    });
  });

  test("picks the run's own signal line out of a host-global sink", () => {
    const record = selectTermination(
      [signalLine("other"), signalLine("b1")],
      "b1",
    );
    expect(record.signal).toEqual({
      at: "2026-08-07T15:18:25.236Z",
      signal: "SIGTERM",
      origin,
    });
    expect(record.armFailure).toBeNull();
  });

  test("matches on buildId alone — a run is found without knowing its worktree", () => {
    const line = signalLine("b1", { worktree: "somewhere-else" });
    expect(selectTermination([line], "b1").signal).not.toBeNull();
  });

  test("an unattributed signal keeps the signal and reports a null origin", () => {
    const record = selectTermination(
      [signalLine("b1", { origin: null })],
      "b1",
    );
    expect(record.signal?.signal).toBe("SIGTERM");
    expect(record.signal?.origin).toBeNull();
  });

  test("an arm failure and a signal are independent facts, both retained", () => {
    const armFailed: SignalOriginLine = {
      at: "2026-08-07T15:00:00.000Z",
      event: "arm-failed",
      buildId: "b1",
      worktree: "att-1",
      reason: "no C toolchain",
    };
    const record = selectTermination(
      [armFailed, signalLine("b1", { origin: null })],
      "b1",
    );
    expect(record.armFailure).toEqual({
      at: "2026-08-07T15:00:00.000Z",
      reason: "no C toolchain",
    });
    expect(record.signal?.origin).toBeNull();
  });

  test("an escalating kill reports the LAST signal line, not the first", () => {
    const first = signalLine("b1", { signal: "SIGINT" });
    const second = signalLine("b1", {
      signal: "SIGTERM",
      at: "2026-08-07T15:18:26.000Z",
    });
    expect(selectTermination([first, second], "b1").signal?.signal).toBe(
      "SIGTERM",
    );
  });
});
