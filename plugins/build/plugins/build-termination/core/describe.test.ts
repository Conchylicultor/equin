import { describe, expect, test } from "bun:test";
import type { SignalOrigin } from "@plugins/packages/plugins/signal-origin/core";
import { describeTermination } from "./describe";
import type { BuildTermination } from "./termination";

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

const empty: BuildTermination = { signal: null, armFailure: null };

describe("describeTermination", () => {
  test("says nothing for a status that is not a death from outside", () => {
    for (const status of ["running", "success", "superseded", "failed"] as const) {
      expect(describeTermination(status, 1, empty)).toBeNull();
    }
  });

  test("names the sender when the tap caught it", () => {
    const d = describeTermination("killed", 143, { signal: { at: "t", signal: "SIGTERM", origin }, armFailure: null });
    expect(d?.headline).toBe(
      "SIGTERM from pid 41234 (/bin/kill) ← 41198 bun, uid 501",
    );
    // Nothing is missing, so nothing is explained away.
    expect(d?.note).toBeNull();
  });

  test("an unattributed signal names the signal and says the sender is unknown", () => {
    const d = describeTermination("killed", 143, {
      signal: { at: "t", signal: "SIGTERM", origin: null },
      armFailure: null,
    });
    expect(d?.headline).toBe("SIGTERM — sender unknown");
    expect(d?.note).toContain("recorded no sender");
  });

  test("an arm failure explains WHY the sender is unknown", () => {
    const d = describeTermination("killed", 143, {
      signal: { at: "t", signal: "SIGTERM", origin: null },
      armFailure: { at: "t0", reason: "cc not found" },
    });
    expect(d?.note).toBe("Attribution was unavailable for this run: cc not found");
  });

  test("a killed run with no record still names the signal from its exit code", () => {
    const d = describeTermination("killed", 130, empty);
    expect(d?.headline).toBe("SIGINT — sender unknown");
    expect(d?.note).toContain("No attribution record");
  });

  test("an interrupted run explains that SIGKILL can never be attributed", () => {
    const d = describeTermination("interrupted", -1, empty);
    expect(d?.headline).toBe("Hard-killed — no signal recorded");
    expect(d?.note).toContain("SIGKILL cannot be caught");
    // -1 is not a 128+signo encoding, so the signal name must not be derived
    // from it (that would print a nonsense `SIG-129`).
    expect(d?.headline).not.toContain("SIG-");
  });

  test("an interrupted run still reports a SIGTERM that preceded the SIGKILL", () => {
    const d = describeTermination("interrupted", -1, {
      signal: { at: "t", signal: "SIGTERM", origin },
      armFailure: null,
    });
    expect(d?.headline).toContain("SIGTERM from pid 41234");
  });

  test("while the record is still loading it claims nothing about attribution", () => {
    const d = describeTermination("killed", 143, null);
    expect(d?.headline).toBe("SIGTERM — sender unknown");
    expect(d?.note).toBeNull();
  });

  test("a killed run with no exit code is still described, not dropped", () => {
    const d = describeTermination("killed", null, empty);
    expect(d?.headline).toBe("A fatal signal — sender unknown");
  });
});
