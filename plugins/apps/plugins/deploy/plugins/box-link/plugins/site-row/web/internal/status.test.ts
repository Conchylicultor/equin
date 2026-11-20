import { describe, expect, it } from "bun:test";
import type { LinkState } from "@plugins/apps/plugins/deploy/plugins/box-link/core";
import type { SiteHealth } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/link/core";

type RunStatus = NonNullable<SiteHealth["run"]>["status"];
import { siteAlert, siteFreshness, siteStatus, siteTitle } from "./status";

const T = Date.parse("2026-11-19T18:00:00Z");

function site(
  state: LinkState | "main-only",
  { run = null, behind = 0 }: { run?: RunStatus | null; behind?: number } = {},
): SiteHealth {
  return {
    deploymentId: "dpl-1",
    compositionId: "website",
    hostname: "equin.ai",
    link:
      state === "main-only"
        ? { kind: "main-only" }
        : {
            kind: "linked",
            link: {
              deploymentId: "dpl-1",
              state,
              since: T,
              lastHeardAt: T,
              lastBeat: null,
              lastError: null,
              hello: null,
            },
          },
    run:
      run === null
        ? null
        : {
            id: "drun-1",
            verb: "update",
            phase: "ship",
            status: run,
            startedAt: new Date(T).toISOString(),
            finishedAt: run === "running" ? null : new Date(T).toISOString(),
            message: run === "failed" ? "health check failed" : null,
          },
    release: {
      kind: "known",
      sha: "abcdef0123456789",
      subject: "s",
      behindMain: behind,
      mainSha: "f".repeat(40),
    },
  };
}

const LIVE: LinkState = { kind: "live" };

describe("siteStatus", () => {
  it("is ok while live and up to date", () => {
    expect(siteStatus(site(LIVE))).toEqual({
      state: "ok",
      summary: "Live · abcdef0 · up to date",
    });
  });

  it("stays ok, naming the commits, while behind main", () => {
    const s = siteStatus(site(LIVE, { behind: 142 }));
    expect(s.state).toBe("ok");
    expect(s.summary).toBe("Live · abcdef0 · 142 commits behind main");
  });

  it("is ok and transitioning while deploying", () => {
    const s = siteStatus(site(LIVE, { run: "running" }));
    expect(s).toMatchObject({ state: "ok", transitioning: true });
  });

  it("needs attention after a failed deploy, or a release too old", () => {
    expect(siteStatus(site(LIVE, { run: "failed" })).state).toBe("attention");
    expect(
      siteStatus(site({ kind: "outdated", reason: "route-missing" })).state,
    ).toBe("attention");
  });

  it("needs attention, transitioning, while reconnecting", () => {
    const s = siteStatus(
      site({
        kind: "reconnecting",
        cause: "slept",
        graceUntil: T + 60_000,
        then: "down",
        sshKind: null,
      }),
    );
    expect(s).toMatchObject({ state: "attention", transitioning: true });
  });

  it("is critical while down, unreachable or refused — whatever the run did", () => {
    for (const state of [
      { kind: "down" },
      { kind: "unreachable", sshKind: null },
      { kind: "refused", reason: "forwarding-refused" },
    ] satisfies LinkState[]) {
      expect(siteStatus(site(state, { run: "running" })).state).toBe(
        "critical",
      );
    }
  });

  it("is not known yet while connecting", () => {
    expect(siteStatus(site({ kind: "connecting" }))).toEqual({
      state: "unknown",
    });
  });

  it("says a real box seen from a worktree is linked from main", () => {
    expect(siteStatus(site("main-only")).summary).toBe(
      "Linked from main · abcdef0 · up to date",
    );
  });
});

describe("siteFreshness / siteAlert / siteTitle", () => {
  it("dims only a linked site whose link is not live", () => {
    expect(siteFreshness(site(LIVE))).toEqual({ kind: "live" });
    expect(siteFreshness(site({ kind: "down" }))).toEqual({
      kind: "stale",
      lastHeardAt: T,
    });
    expect(siteFreshness(site("main-only"))).toEqual({ kind: "elsewhere" });
  });

  it("alerts on a lost link before a failed run, and not on a healthy site", () => {
    expect(siteAlert(site(LIVE))).toBeNull();
    expect(siteAlert(site({ kind: "down" }))?.tone).toBe("critical");
    expect(siteAlert(site(LIVE, { run: "failed" }))?.lead).toBe(
      "health check failed",
    );
  });

  it("names a site by its hostname, else its composition", () => {
    expect(siteTitle(site(LIVE))).toBe("equin.ai");
    expect(siteTitle({ ...site(LIVE), hostname: null })).toBe("website");
  });
});
