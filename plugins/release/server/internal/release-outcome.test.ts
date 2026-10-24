/**
 * The release plugin's first tests, and they cover the decision the migration
 * made testable: what a finished `./equin release` MEANS.
 *
 * Everything else the old `run-release.ts` did on the way to that verdict —
 * probing pids, reading a parent-written recovery artifact, closing orphan rows
 * — now belongs to the supervised-run primitive and is tested there. What is
 * left here is release-specific and pure: the manifest is the artifact's own
 * receipt, and a signal is an OBSERVATION that must never be re-derived from the
 * exit code.
 */

import { describe, expect, test } from "bun:test";
import {
  releaseFailureMessage,
  releaseSucceeded,
  type ReleaseEnding,
} from "./release-outcome";

function ending(over: Partial<ReleaseEnding> = {}): ReleaseEnding {
  return {
    exitCode: 0,
    signalCode: null,
    manifest: true,
    durationSeconds: 12,
    ...over,
  };
}

describe("releaseSucceeded", () => {
  test("exit 0 with a manifest is the only success", () => {
    expect(releaseSucceeded(ending())).toBe(true);
  });

  test("exit 0 without a manifest is not a success", () => {
    expect(releaseSucceeded(ending({ manifest: false }))).toBe(false);
  });

  test("a non-zero exit is not a success even with a manifest on disk", () => {
    expect(releaseSucceeded(ending({ exitCode: 1 }))).toBe(false);
  });

  test("a recorded SIGINT does not fail a run that completed", () => {
    // POSIX has a non-interactive shell set INT to ignore for an asynchronous
    // list's commands, so a group SIGINT never reaches the child: it runs to
    // completion and exits 0, and the shim records the signal it saw. Treating
    // `signalCode !== null` as failure here would fail a release that genuinely
    // produced its artifact.
    expect(releaseSucceeded(ending({ signalCode: "INT" }))).toBe(true);
  });
});

describe("releaseFailureMessage", () => {
  test("a killed run says so, and never quotes its status as one", () => {
    const message = releaseFailureMessage(
      ending({ exitCode: 143, signalCode: "TERM", manifest: false }),
    );
    expect(message).toContain("killed by TERM");
    expect(message).not.toContain("code 143");
  });

  test("a deliberate exit(143) is NOT reported as a kill", () => {
    // The pair that pins the whole design: `128 + signo` and a chosen status are
    // the same number, so only the observed signal may decide. Deriving
    // killed-ness from `exitCode > 128` would collapse these two cases — which
    // is what recorded a killed deploy as `Exited with code 143`.
    const message = releaseFailureMessage(
      ending({ exitCode: 143, signalCode: null, manifest: false }),
    );
    expect(message).toBe("Release exited with code 143 after 12s");
  });

  test("no exit marker at all reads as a vanished process, not a status", () => {
    const message = releaseFailureMessage(
      ending({ exitCode: -1, signalCode: null, manifest: false }),
    );
    expect(message).toContain("disappeared without recording an outcome");
    expect(message).not.toContain("code -1");
  });

  test("a clean exit with no artifact says that, not 'exited with code 0'", () => {
    const message = releaseFailureMessage(ending({ manifest: false }));
    expect(message).toContain("wrote no RELEASE.json");
  });

  test("an ordinary non-zero exit keeps the wording the ledger already carries", () => {
    expect(
      releaseFailureMessage(
        ending({ exitCode: 2, manifest: false, durationSeconds: 305 }),
      ),
    ).toBe("Release exited with code 2 after 305s");
  });
});
