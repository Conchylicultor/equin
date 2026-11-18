import { describe, expect, test } from "bun:test";
import type { ForwarderStatus, GitHubEventsStatus } from "../../core";
import { githubEventsHealth } from "./status-view";

const refetch = async () => {};
const ready = (data: GitHubEventsStatus) =>
  ({ status: "ready", data, refetch }) as const;
const since = "2026-11-18T10:00:00.000Z";
const fwd = (
  repo: string,
  state: ForwarderStatus["state"],
  detail: string | null = null,
): ForwarderStatus => ({ repo, state, detail, since });

describe("the GitHub events row", () => {
  test("is absent off the publisher and without the computer", () => {
    expect(githubEventsHealth(ready({ kind: "off" }))).toEqual({
      state: "absent",
    });
    expect(
      githubEventsHealth({ status: "unavailable", message: "no machine" }),
    ).toEqual({ state: "absent" });
  });

  test("not set up says why and how to fix it", () => {
    expect(
      githubEventsHealth(
        ready({
          kind: "not-set-up",
          reason: "the gh webhook extension is not installed",
          fix: "gh extension install cli/gh-webhook",
        }),
      ),
    ).toEqual({
      state: "attention",
      title: "GitHub events not set up",
      summary:
        "Not set up: the gh webhook extension is not installed — run `gh extension install cli/gh-webhook`",
    });
  });

  test("connected once GitHub pinged every forwarder", () => {
    expect(
      githubEventsHealth(
        ready({
          kind: "on",
          forwarders: [fwd("a/x", "connected"), fwd("a/y", "connected")],
        }),
      ),
    ).toEqual({ state: "ok", summary: "Connected · 2 repos" });
  });

  test("connecting pulses; reconnecting is attention, pulsing, with why", () => {
    expect(
      githubEventsHealth(
        ready({
          kind: "on",
          forwarders: [fwd("a/x", "connected"), fwd("a/y", "connecting")],
        }),
      ),
    ).toEqual({
      state: "ok",
      summary: "Connecting 1 repo…",
      transitioning: true,
    });
    expect(
      githubEventsHealth(
        ready({
          kind: "on",
          forwarders: [fwd("a/x", "reconnecting", "websocket closed")],
        }),
      ),
    ).toEqual({
      state: "attention",
      summary: "Reconnecting — a/x: websocket closed",
      transitioning: true,
    });
  });

  test("a forwarder that gave up is attention, named", () => {
    expect(
      githubEventsHealth(
        ready({
          kind: "on",
          forwarders: [
            fwd("a/x", "failed", "HTTP 404: Not Found"),
            fwd("a/y", "reconnecting"),
          ],
        }),
      ),
    ).toMatchObject({
      state: "attention",
      title: "GitHub events stopped",
      summary: "Forwarder gave up — a/x: HTTP 404: Not Found",
    });
  });
});
