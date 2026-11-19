import { describe, expect, test } from "bun:test";
import { buildStatusOf, killedSignalName } from "./build-status";

const FINISHED = new Date("2026-08-07T12:00:00Z");

describe("buildStatusOf", () => {
  test("a run with no finishedAt is running, whatever the exit code says", () => {
    expect(buildStatusOf({ finishedAt: null, exitCode: null })).toBe("running");
    expect(buildStatusOf({ finishedAt: null, exitCode: 0 })).toBe("running");
    expect(buildStatusOf({ finishedAt: null, exitCode: 1 })).toBe("running");
  });

  test("exit 0 is success", () => {
    expect(buildStatusOf({ finishedAt: FINISHED, exitCode: 0 })).toBe("success");
  });

  test("a nonzero verdict of the build's own is the only failure", () => {
    expect(buildStatusOf({ finishedAt: FINISHED, exitCode: 1 })).toBe("failed");
    expect(buildStatusOf({ finishedAt: FINISHED, exitCode: 2 })).toBe("failed");
    // The pre-Step-0 killed-build path recorded no code at all. Nothing about it
    // distinguishes it from a real failure, so it stays a failure.
    expect(buildStatusOf({ finishedAt: FINISHED, exitCode: null })).toBe("failed");
  });

  test("BUILD_EXIT_SUPERSEDED (75) is superseded", () => {
    expect(buildStatusOf({ finishedAt: FINISHED, exitCode: 75 })).toBe("superseded");
  });

  test("-1 is interrupted, not superseded and not a failure", () => {
    expect(buildStatusOf({ finishedAt: FINISHED, exitCode: -1 })).toBe("interrupted");
  });

  test("128 + signo is killed", () => {
    expect(buildStatusOf({ finishedAt: FINISHED, exitCode: 129 })).toBe("killed"); // SIGHUP
    expect(buildStatusOf({ finishedAt: FINISHED, exitCode: 130 })).toBe("killed"); // SIGINT
    expect(buildStatusOf({ finishedAt: FINISHED, exitCode: 131 })).toBe("killed"); // SIGQUIT
    expect(buildStatusOf({ finishedAt: FINISHED, exitCode: 143 })).toBe("killed"); // SIGTERM
  });

  test("BUILD_EXIT_OUT_OF_MEMORY (71) is out-of-memory, not a failure", () => {
    expect(buildStatusOf({ finishedAt: FINISHED, exitCode: 71 })).toBe(
      "out-of-memory",
    );
    expect(buildStatusOf({ finishedAt: FINISHED, exitCode: 70 })).toBe(
      "failed",
    );
    expect(buildStatusOf({ finishedAt: FINISHED, exitCode: 72 })).toBe(
      "failed",
    );
  });

  test("a SIGKILL without the out-of-memory code stays killed", () => {
    expect(buildStatusOf({ finishedAt: FINISHED, exitCode: 137 })).toBe(
      "killed",
    );
  });

  test("128 itself is not a signal death", () => {
    expect(buildStatusOf({ finishedAt: FINISHED, exitCode: 128 })).toBe("failed");
  });
});

describe("killedSignalName", () => {
  test("names the signals the CLI's own handlers produce", () => {
    expect(killedSignalName(129)).toBe("SIGHUP");
    expect(killedSignalName(130)).toBe("SIGINT");
    expect(killedSignalName(131)).toBe("SIGQUIT");
    expect(killedSignalName(143)).toBe("SIGTERM");
  });

  test("names a signal nobody sent through us", () => {
    expect(killedSignalName(137)).toBe("SIGKILL");
  });

  test("an unmapped signo still says something true", () => {
    expect(killedSignalName(228)).toBe("SIG100");
  });
});
