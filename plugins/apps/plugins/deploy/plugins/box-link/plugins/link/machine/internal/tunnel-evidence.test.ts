import { describe, expect, test } from "bun:test";
import { createTunnelEvidence } from "./tunnel-evidence";

describe("tunnel evidence", () => {
  test("an unanswered stream waits for ssh to answer, then is down", () => {
    const ev = createTunnelEvidence();
    expect(ev.unanswered("d1", 10, "socket closed")).toBe("pending");
    expect(ev.sshAnswered(12)).toEqual([
      { deploymentId: "d1", error: "socket closed" },
    ]);
    expect(ev.sshAnswered(13)).toEqual([]);
  });

  test("ssh answering first (after the attempt began) settles it at once", () => {
    const ev = createTunnelEvidence();
    expect(ev.sshAnswered(12)).toEqual([]);
    expect(ev.unanswered("d1", 10, "socket closed")).toBe("down");
  });

  test("an answer from before the attempt began proves nothing about it", () => {
    const ev = createTunnelEvidence();
    ev.sshAnswered(5);
    expect(ev.unanswered("d1", 10, "socket closed")).toBe("pending");
  });

  test("the tunnel ending drops what was pending and what it showed", () => {
    const ev = createTunnelEvidence();
    ev.sshAnswered(12);
    ev.reset();
    expect(ev.unanswered("d1", 10, "socket closed")).toBe("pending");
    ev.reset();
    expect(ev.sshAnswered(20)).toEqual([]);
  });

  test("a stream that heard the box is no longer pending", () => {
    const ev = createTunnelEvidence();
    ev.unanswered("d1", 10, "socket closed");
    ev.heard("d1");
    expect(ev.sshAnswered(12)).toEqual([]);
  });
});
