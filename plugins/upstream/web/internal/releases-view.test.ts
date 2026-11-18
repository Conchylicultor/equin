import { describe, expect, test } from "bun:test";
import { INSTALLER_BINARIES } from "@plugins/installer/plugins/release-assets/core";
import type {
  GitHubPublication,
  PublisherStatus,
  Releasability,
} from "@plugins/upstream/plugins/release/core";
import {
  commitLineParts,
  githubPublication,
  nextRelease,
  releasesBody,
  releasesHealth,
  releasesSubtitle,
  type Publisher,
} from "./releases-view";

const refetch = async () => {};
const ready = (data: PublisherStatus) =>
  ({ status: "ready", data, refetch }) as const;
const now = new Date("2026-11-17T14:00:00.000Z");
const served = "247f2541c0ffee0000000000000000000000beef";
const building = "8c1e2f0aa000000000000000000000000000cafe";

function publisher(
  releasable: Releasability,
  over: Partial<Publisher> = {},
): Publisher {
  return {
    kind: "publisher",
    latest: { tag: "v2026.11.17", taggedAt: "2026-11-17T08:00:00.000Z" },
    unreleased: 142,
    releasable,
    github: null,
    ...over,
  };
}

describe("the releases row", () => {
  test("is absent where releases are not cut, or with no computer", () => {
    expect(releasesHealth(ready({ kind: "not-publisher" }))).toEqual({
      state: "absent",
    });
    expect(
      releasesHealth({ status: "unavailable", message: "no machine" }),
    ).toEqual({ state: "absent" });
  });

  test("names the newest release and when it was cut", () => {
    const sixHoursAgo = new Date(Date.now() - 6 * 3600_000).toISOString();
    expect(
      releasesSubtitle({ tag: "v2026.11.17", taggedAt: sixHoursAgo }),
    ).toBe("Latest 2026.11.17 · 6h ago");
    expect(releasesSubtitle(null)).toBe("No release yet");
  });

  test("the next release is today's next number", () => {
    const latest = { tag: "v2026.11.17", taggedAt: now.toISOString() };
    expect(nextRelease(latest, now)).toBe("v2026.11.17.2");
    expect(
      nextRelease({ tag: "v2026.11.17.2", taggedAt: now.toISOString() }, now),
    ).toBe("v2026.11.17.3");
    expect(
      nextRelease({ tag: "v2026.11.14", taggedAt: now.toISOString() }, now),
    ).toBe("v2026.11.17");
    expect(nextRelease(null, now)).toBe("v2026.11.17");
  });

  test("ready: the button tags the served commit", () => {
    const body = releasesBody(
      publisher({ kind: "ready", commit: served }),
      now,
    );
    expect(commitLineParts(body.line)).toEqual({
      count: "142",
      rest: " unreleased commits",
    });
    expect(body.action).toEqual({
      label: "Release 2026.11.17.2",
      enabled: true,
      tooltip:
        "Tag 247f2541c — the commit main serves, built and checked — as v2026.11.17.2 and publish it",
      failedRunId: null,
    });
    expect(
      releasesHealth(ready(publisher({ kind: "ready", commit: served }))),
    ).toEqual({
      state: "ok",
      title: "equin releases",
      summary: expect.any(String),
    });
  });

  test("building: disabled, the commit line says so, the dot pulses", () => {
    const status = publisher({ kind: "building", commit: building });
    const body = releasesBody(status, now);
    expect(commitLineParts(body.line).rest).toBe(
      " unreleased commits · main is building 8c1e2f0",
    );
    expect(body.action).toMatchObject({ enabled: false, failedRunId: null });
    expect(releasesHealth(ready(status))).toMatchObject({
      state: "ok",
      transitioning: true,
    });
  });

  test("failed: disabled, with the build to open, still ok", () => {
    const status = publisher({
      kind: "failed",
      commit: building,
      runId: "build-1",
    });
    expect(releasesHealth(ready(status))).toMatchObject({ state: "ok" });
    const body = releasesBody(status, now);
    expect(commitLineParts(body.line).rest).toBe(
      " unreleased commits · main's last build failed",
    );
    expect(body.action).toMatchObject({
      enabled: false,
      failedRunId: "build-1",
      tooltip:
        "Main's build of 8c1e2f0 failed — only a commit whose build passed can be released",
    });
  });

  test("released: nothing unreleased, no button", () => {
    const status = publisher(
      { kind: "released", commit: served, tag: "v2026.11.17.2" },
      { unreleased: 0 },
    );
    const body = releasesBody(status, now);
    expect(body.action).toBeNull();
    expect(commitLineParts(body.line)).toEqual({
      count: null,
      rest: "No unreleased commits",
    });
    expect(releasesHealth(ready(status))).toMatchObject({ state: "ok" });
  });

  test("one commit is a commit", () => {
    expect(commitLineParts({ unreleased: 1, note: null }).rest).toBe(
      " unreleased commit",
    );
  });
});

const runUrl = "https://github.com/equinai/equin/actions/runs/1";
const releaseUrl = "https://github.com/equinai/equin/releases/tag/v2026.11.17";
const installers = Object.values(INSTALLER_BINARIES);
const coreAssets = ["install.sh", "release.json", "SHA256SUMS"];

function connected(
  run: { status: string; conclusion: string | null } | null,
  release: { draft: boolean; assets: string[] } | null,
): GitHubPublication {
  return {
    kind: "connected",
    run: run === null ? null : { ...run, url: runUrl },
    release: release === null ? null : { ...release, url: releaseUrl },
  };
}

const inProgress = { status: "in_progress", conclusion: null };
const failedRun = { status: "completed", conclusion: "failure" };
const passedRun = { status: "completed", conclusion: "success" };

describe("what GitHub published of the newest release", () => {
  test("not connected: unknown, claims nothing", () => {
    expect(
      githubPublication({
        kind: "not-connected",
        reason: "GitHub reconnecting",
      }),
    ).toEqual({
      health: "unknown",
      pulsing: false,
      words: "GitHub not connected",
      runUrl: null,
    });
  });

  test("no run seen for the tag yet: waiting, pulsing", () => {
    expect(githubPublication(connected(null, null))).toMatchObject({
      health: "ok",
      pulsing: true,
      words: "Waiting for GitHub",
      runUrl: null,
    });
  });

  test("run in progress, no public Release: publishing, pulsing", () => {
    expect(githubPublication(connected(inProgress, null))).toMatchObject({
      health: "ok",
      pulsing: true,
      words: "Publishing on GitHub…",
      runUrl,
    });
    expect(
      githubPublication(
        connected(inProgress, { draft: true, assets: coreAssets }),
      ),
    ).toMatchObject({ words: "Publishing on GitHub…", pulsing: true });
  });

  test("Release public, installers missing, run in progress: installer building", () => {
    expect(
      githubPublication(
        connected(inProgress, { draft: false, assets: coreAssets }),
      ),
    ).toMatchObject({
      health: "ok",
      pulsing: true,
      words: "On GitHub · installer building",
    });
  });

  test("Release public with every installer binary: ok", () => {
    for (const run of [passedRun, failedRun, null]) {
      expect(
        githubPublication(
          connected(run, {
            draft: false,
            assets: [...coreAssets, ...installers],
          }),
        ),
      ).toMatchObject({ health: "ok", pulsing: false, words: "On GitHub" });
    }
  });

  test("one installer binary missing is not every one", () => {
    expect(
      githubPublication(
        connected(failedRun, {
          draft: false,
          assets: [...coreAssets, ...installers.slice(1)],
        }),
      ),
    ).toMatchObject({ health: "attention" });
  });

  test("run failed, no public Release: attention, with the run", () => {
    expect(githubPublication(connected(failedRun, null))).toEqual({
      health: "attention",
      pulsing: false,
      words: "GitHub release failed",
      runUrl,
    });
    expect(
      githubPublication(
        connected(
          { status: "completed", conclusion: "timed_out" },
          { draft: true, assets: [] },
        ),
      ),
    ).toMatchObject({ health: "attention", words: "GitHub release failed" });
  });

  test("Release public, installer jobs failed: attention", () => {
    expect(
      githubPublication(
        connected(failedRun, { draft: false, assets: coreAssets }),
      ),
    ).toEqual({
      health: "attention",
      pulsing: false,
      words: "On GitHub without the installer window",
      runUrl,
    });
  });

  test("Release public, no run seen: on GitHub without a window, still ok", () => {
    expect(
      githubPublication(connected(null, { draft: false, assets: coreAssets })),
    ).toMatchObject({
      health: "ok",
      pulsing: false,
      words: "On GitHub · no installer window",
    });
  });

  test("the row: the failure colours it, not connected greys it", () => {
    const status = (github: GitHubPublication) =>
      ready(publisher({ kind: "ready", commit: served }, { github }));
    expect(releasesHealth(status(connected(failedRun, null)))).toMatchObject({
      state: "attention",
      title: "equin releases",
      summary: expect.stringContaining("· GitHub release failed"),
    });
    expect(
      releasesHealth(status({ kind: "not-connected", reason: "x" })),
    ).toEqual({
      state: "unknown",
      summary: expect.stringContaining("· GitHub not connected"),
    });
    expect(releasesHealth(status(connected(inProgress, null)))).toMatchObject({
      state: "ok",
      transitioning: true,
      summary: expect.stringContaining("· Publishing on GitHub…"),
    });
  });
});
