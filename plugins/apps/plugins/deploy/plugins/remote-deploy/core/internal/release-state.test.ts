import { describe, expect, test } from "bun:test";
import type { ReleaseCandidate, ReleaseRun } from "@plugins/release/core";
import { releaseRunIdKind } from "@plugins/release/plugins/bundles/core";
import { candidatePredatesLatest } from "./release-state";

const T = (min: number) =>
  new Date(Date.parse("2026-10-02T10:00:00Z") + min * 60_000);

function run(over: Partial<ReleaseRun> = {}): ReleaseRun {
  return {
    id: releaseRunIdKind.key("release-new"),
    composition: "c",
    target: "web",
    namespace: "ns",
    kind: "candidate",
    status: "succeeded",
    startedAt: T(0),
    finishedAt: T(5),
    exitCode: 0,
    platform: "linux-x64",
    artifactPath: null,
    port: null,
    commitSha: null,
    commitDirty: null,
    error: null,
    ...over,
  };
}

function resolved(
  runId: string,
  builtAt: Date,
  observedAt = T(10),
): ReleaseCandidate {
  return {
    resolution: {
      ok: true,
      runId,
      localPath: "/x",
      binaryName: "c-web-linux-x64",
      manifest: {
        composition: "c",
        target: "web",
        platform: "linux-x64",
        builtAt: builtAt.toISOString(),
        port: 1,
        runId,
      },
    },
    staleness: { kind: "unknown", reason: "r" },
    observedAt,
  };
}

function refused(
  kind: "no-pointer" | "not-packed",
  observedAt: Date,
): ReleaseCandidate {
  return {
    resolution: {
      ok: false,
      refusal:
        kind === "no-pointer"
          ? {
              kind,
              pointer: "latest-linux-x64",
              pointerPath: "/p",
              namespace: "ns",
            }
          : { kind, localPath: "/l" },
    },
    staleness: { kind: "unknown", reason: "r" },
    observedAt,
  };
}

describe("candidatePredatesLatest — hold loading only on a provable lag", () => {
  test("an older bundle than a succeeded candidate run of this platform holds", () => {
    expect(
      candidatePredatesLatest(
        resolved("release-old", T(-10)),
        run(),
        "linux-x64",
      ),
    ).toBe(true);
  });

  test("the run's own bundle does not hold", () => {
    expect(
      candidatePredatesLatest(
        resolved("release-new", T(4)),
        run(),
        "linux-x64",
      ),
    ).toBe(false);
  });

  test("a bundle built after the run started does not hold", () => {
    expect(
      candidatePredatesLatest(
        resolved("release-other", T(1)),
        run(),
        "linux-x64",
      ),
    ).toBe(false);
  });

  test("a missing pointer observed before the run finished holds; after, it does not", () => {
    expect(
      candidatePredatesLatest(refused("no-pointer", T(3)), run(), "linux-x64"),
    ).toBe(true);
    expect(
      candidatePredatesLatest(refused("no-pointer", T(6)), run(), "linux-x64"),
    ).toBe(false);
  });

  test("any other refusal renders as it stands", () => {
    expect(
      candidatePredatesLatest(refused("not-packed", T(3)), run(), "linux-x64"),
    ).toBe(false);
  });

  test("no run, a running/failed/staged run, another platform or target never holds", () => {
    const old = resolved("release-old", T(-10));
    expect(candidatePredatesLatest(old, null, "linux-x64")).toBe(false);
    for (const over of [
      { status: "running", finishedAt: null },
      { status: "failed" },
      { kind: "staged" },
      { platform: "linux-arm64" },
      { target: "tauri" },
    ] as const) {
      expect(candidatePredatesLatest(old, run(over), "linux-x64")).toBe(false);
    }
  });
});
