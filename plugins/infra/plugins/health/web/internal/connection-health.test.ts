import { describe, expect, test } from "bun:test";
import type { ChannelStatuses } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { WsStatus } from "@plugins/primitives/plugins/networking/web";
import { connectionHealth, PUSH_STALL_MS } from "./connection-health";

/** Both sockets' states, with each server's latest reported flush age (ms). */
function sockets(
  worktree: WsStatus,
  central: WsStatus,
  pushStallMs: Partial<ChannelStatuses["serverPushStallMs"]> = {},
  stalledResources: Partial<ChannelStatuses["serverStalledResources"]> = {},
): ChannelStatuses {
  return {
    worktree,
    central,
    serverPushStallMs: { worktree: 0, central: 0, ...pushStallMs },
    serverStalledResources: { worktree: [], central: [], ...stalledResources },
  };
}

const MIN = 60_000;

describe("connectionHealth", () => {
  test("both sockets open is ok", () => {
    expect(connectionHealth(sockets("open", "open"))).toEqual({
      state: "ok",
      summary: "Server and central connected",
    });
  });

  test("a closed socket is critical and names which", () => {
    expect(connectionHealth(sockets("closed", "open"))).toEqual({
      state: "critical",
      summary: "Server disconnected",
    });
    expect(connectionHealth(sockets("open", "closed"))).toEqual({
      state: "critical",
      summary: "Central disconnected",
    });
    expect(connectionHealth(sockets("closed", "closed"))).toEqual({
      state: "critical",
      summary: "Server and central disconnected",
    });
  });

  test("closed outranks the other socket reconnecting", () => {
    expect(connectionHealth(sockets("reconnecting", "closed"))).toEqual({
      state: "critical",
      summary: "Central disconnected",
    });
  });

  test("a (re)connecting socket is attention, transitioning, and names which", () => {
    expect(connectionHealth(sockets("reconnecting", "open"))).toEqual({
      state: "attention",
      summary: "Reconnecting to server…",
      transitioning: true,
    });
    expect(connectionHealth(sockets("open", "connecting"))).toEqual({
      state: "attention",
      summary: "Connecting to central…",
      transitioning: true,
    });
  });

  test("both sockets on the way back share one verb when they can", () => {
    expect(connectionHealth(sockets("reconnecting", "reconnecting"))).toEqual({
      state: "attention",
      summary: "Reconnecting to server and central…",
      transitioning: true,
    });
    expect(connectionHealth(sockets("reconnecting", "connecting"))).toEqual({
      state: "attention",
      summary: "Reconnecting to server, connecting to central…",
      transitioning: true,
    });
  });
});

describe("connectionHealth — live updates stuck behind a server flush", () => {
  test("a server flush open for 30 s or more is critical, with how long", () => {
    expect(
      connectionHealth(sockets("open", "open", { worktree: 3 * MIN + 20_000 })),
    ).toEqual({
      state: "critical",
      summary:
        "Connected, but live updates have been stuck for 3 min — changes are saved but won't appear until the server restarts",
    });
    expect(
      connectionHealth(sockets("open", "open", { worktree: PUSH_STALL_MS })),
    ).toEqual({
      state: "critical",
      summary:
        "Connected, but live updates have been stuck for 30 s — changes are saved but won't appear until the server restarts",
    });
  });

  test("names central, or both, and reports the longer stall", () => {
    expect(
      connectionHealth(sockets("open", "open", { central: 25 * MIN })),
    ).toEqual({
      state: "critical",
      summary:
        "Connected, but live updates have been stuck for 25 min — changes are saved but won't appear until central restarts",
    });
    expect(
      connectionHealth(
        sockets("open", "open", { worktree: 2 * MIN, central: 65 * MIN }),
      ),
    ).toEqual({
      state: "critical",
      summary:
        "Connected, but live updates have been stuck for 1 h 5 min — changes are saved but won't appear until the server and central restart",
    });
  });

  test("below 30 s nothing changes", () => {
    expect(
      connectionHealth(
        sockets("open", "open", { worktree: PUSH_STALL_MS - 1, central: 5 }),
      ),
    ).toEqual({ state: "ok", summary: "Server and central connected" });
    expect(
      connectionHealth(
        sockets("open", "reconnecting", { worktree: PUSH_STALL_MS - 1 }),
      ),
    ).toEqual({
      state: "attention",
      summary: "Reconnecting to central…",
      transitioning: true,
    });
  });

  test("a closed socket still outranks a stuck one", () => {
    expect(
      connectionHealth(sockets("open", "closed", { worktree: 10 * MIN })),
    ).toEqual({ state: "critical", summary: "Central disconnected" });
  });

  test("a stuck server outranks the other socket reconnecting", () => {
    expect(
      connectionHealth(sockets("open", "reconnecting", { worktree: 4 * MIN }))
        .summary,
    ).toBe(
      "Connected, but live updates have been stuck for 4 min — changes are saved but won't appear until the server restarts",
    );
  });

  test("a socket that is not open never reads as stuck", () => {
    expect(
      connectionHealth(sockets("reconnecting", "open", { worktree: 10 * MIN })),
    ).toEqual({
      state: "attention",
      summary: "Reconnecting to server…",
      transitioning: true,
    });
  });
});

describe("connectionHealth — one resource stuck while the rest flow", () => {
  test("names the resource and says everything else still updates", () => {
    expect(
      connectionHealth(
        sockets(
          "open",
          "open",
          {},
          {
            worktree: [{ key: "host-fs.peek", ms: 93_000 }],
          },
        ),
      ),
    ).toEqual({
      state: "attention",
      summary:
        "Live updates stuck for 1 min on host-fs.peek — everything else is still updating",
    });
  });

  test("names two, then counts the rest, across both servers, with the longest age", () => {
    expect(
      connectionHealth(
        sockets(
          "open",
          "open",
          {},
          {
            worktree: [
              { key: "a", ms: 5 * MIN },
              { key: "b", ms: 2 * MIN },
              { key: "c", ms: PUSH_STALL_MS },
            ],
            central: [{ key: "d", ms: 7 * MIN }],
          },
        ),
      ).summary,
    ).toBe(
      "Live updates stuck for 7 min on a, b and 2 others — everything else is still updating",
    );
  });

  test("below 30 s, or on a socket that is not open, nothing changes", () => {
    expect(
      connectionHealth(
        sockets(
          "open",
          "open",
          {},
          {
            worktree: [{ key: "a", ms: PUSH_STALL_MS - 1 }],
          },
        ),
      ),
    ).toEqual({ state: "ok", summary: "Server and central connected" });
    expect(
      connectionHealth(
        sockets(
          "reconnecting",
          "open",
          {},
          {
            worktree: [{ key: "a", ms: 10 * MIN }],
          },
        ),
      ).summary,
    ).toBe("Reconnecting to server…");
  });

  test("every push stopped outranks one resource stuck", () => {
    expect(
      connectionHealth(
        sockets(
          "open",
          "open",
          { worktree: 2 * MIN },
          {
            worktree: [{ key: "a", ms: 10 * MIN }],
          },
        ),
      ).state,
    ).toBe("critical");
  });
});
