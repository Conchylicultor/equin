import { describe, expect, test } from "bun:test";
import type {
  PublisherStatus,
  Releasability,
} from "@plugins/upstream/plugins/release/core";
import {
  commitLineParts,
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
