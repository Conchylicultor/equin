import { describe, expect, test } from "bun:test";
import {
  authoredSignalOf,
  ChildKilledError,
  childSignalOf,
  killedByOf,
  signalExitCode,
} from "./child-killed";

describe("signalExitCode / authoredSignalOf", () => {
  test("round-trip the signals an OOM kill or a crash ends a child with", () => {
    for (const signal of [
      "SIGKILL",
      "SIGTERM",
      "SIGSEGV",
      "SIGABRT",
      "SIGBUS",
    ]) {
      expect(authoredSignalOf(signalExitCode(signal))).toBe(signal);
    }
    expect(signalExitCode("SIGKILL")).toBe(137);
    expect(signalExitCode("SIGTERM")).toBe(143);
  });

  test("a numbered signal (a Linux real-time one, as Bun reports it) keeps its number", () => {
    expect(signalExitCode("40")).toBe(168);
    expect(signalExitCode("SIG40")).toBe(168);
    expect(authoredSignalOf(168)).toBe("SIG40");
  });

  test("an unknown signal name throws rather than inventing a number", () => {
    expect(() => signalExitCode("SIGNOPE")).toThrow(/no signal number/);
  });

  test("an ordinary exit is no signal", () => {
    for (const code of [0, 1, 2, 75, 128, 255])
      expect(authoredSignalOf(code)).toBeNull();
  });

  test("childSignalOf prefers the kernel's signal over the exit code", () => {
    expect(childSignalOf({ exitCode: 1, signalCode: "SIGKILL" })).toBe(
      "SIGKILL",
    );
    expect(childSignalOf({ exitCode: 137, signalCode: null })).toBe("SIGKILL");
    expect(childSignalOf({ exitCode: 1, signalCode: null })).toBeNull();
  });
});

describe("killedByOf", () => {
  test("finds the error itself, or one in its cause chain", () => {
    const killed = new ChildKilledError("type-check batch 3", "SIGKILL");
    expect(killedByOf(killed)).toBe(killed);
    expect(
      killedByOf(
        new Error("outer", { cause: new Error("mid", { cause: killed }) }),
      ),
    ).toBe(killed);
  });

  test("anything else is not a kill", () => {
    expect(killedByOf(new Error("type error"))).toBeNull();
    expect(killedByOf("a string")).toBeNull();
    expect(killedByOf(undefined)).toBeNull();
  });
});
