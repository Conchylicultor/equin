import { describe, expect, it, vi } from "vitest";
import { REPLAY_PROTOCOL } from "../../core";
import { followReplay, type ReplayFollowDeps } from "../internal/replay-follow";

/** A follower over fakes; `send` delivers one message as if posted to the page. */
function harness(over: Partial<ReplayFollowDeps> = {}) {
  const parent = { postMessage: vi.fn() } as unknown as Window;
  let listener: ((e: MessageEvent) => void) | null = null;
  const navigate = vi.fn();
  const section = document.createElement("section");
  section.scrollIntoView = vi.fn();
  document.body.replaceChildren(section);
  const deps: ReplayFollowDeps = {
    host: "website.att-1.localhost:9000",
    parent,
    navigate,
    currentPath: () => "/about",
    sectionElement: (path, name) =>
      path === "/about" && name === "landing/hero" ? section : null,
    sectionsOf: () => ["landing/hero"],
    addMessageListener: (fn) => {
      listener = fn;
    },
    ...over,
  };
  const followed = followReplay(deps);
  return {
    followed,
    parent,
    navigate,
    section,
    send: (data: unknown, from: { source?: unknown; origin?: string } = {}) => {
      if (!listener) throw new Error("no listener installed");
      listener({
        data,
        source: "source" in from ? from.source : parent,
        origin: from.origin ?? "http://equin.localhost:9000",
      } as MessageEvent);
    },
  };
}

describe("followReplay", () => {
  it("installs nothing on a public host, or when not framed", () => {
    expect(harness({ host: "equin.ai" }).followed).toBe(false);
    expect(harness({ parent: null }).followed).toBe(false);
  });

  it("says it is ready to its parent", () => {
    const h = harness();
    expect(h.followed).toBe(true);
    expect(h.parent.postMessage).toHaveBeenCalledWith(
      { protocol: REPLAY_PROTOCOL, kind: "ready" },
      "*",
    );
  });

  it("navigates in-app, and not to the page it is on", () => {
    const h = harness();
    h.send({ protocol: REPLAY_PROTOCOL, kind: "navigate", path: "/about" });
    h.send({
      protocol: REPLAY_PROTOCOL,
      kind: "navigate",
      path: "/about/vision?x=1",
    });
    expect(h.navigate.mock.calls).toEqual([["/about/vision"]]);
  });

  it("scrolls a mounted section into view; an unknown one is skipped", () => {
    const h = harness();
    h.send({
      protocol: REPLAY_PROTOCOL,
      kind: "scroll-to",
      section: "landing/hero",
    });
    h.send({
      protocol: REPLAY_PROTOCOL,
      kind: "scroll-to",
      section: "landing/gone",
    });
    expect(h.section.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("ignores a message from another window, a public origin, or off-protocol", () => {
    const h = harness();
    const cmd = { protocol: REPLAY_PROTOCOL, kind: "navigate", path: "/x" };
    h.send(cmd, { source: {} });
    h.send(cmd, { origin: "https://evil.example" });
    h.send(cmd, { origin: "http://proto-1.content.localhost:9000" });
    h.send({ ...cmd, protocol: "other/1" });
    h.send({ ...cmd, extra: true });
    expect(h.navigate).not.toHaveBeenCalled();
  });
});
