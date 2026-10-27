/**
 * The frame-serving Service Worker's reading of a URL: a server id then its
 * `/api` path, anything else not a frame URL, and an encoded traversal or
 * separator refused — the URL parser folds literal dot segments, never
 * encoded ones.
 */

import { describe, expect, test } from "bun:test";
import {
  framesScope,
  isFramesScope,
  routeFrameRequest,
} from "./frames-protocol";

const SCOPE = "/artifacts/host-x/frames/";

describe("routeFrameRequest", () => {
  test("a server id, then the server's own path, still encoded", () => {
    expect(
      routeFrameRequest(SCOPE, `${SCOPE}sid/api/prototypes/a%20b/index.html`),
    ).toEqual({
      kind: "route",
      serverId: "sid",
      path: "/api/prototypes/a%20b/index.html",
    });
  });

  test("no server id, or a path outside /api, is not a frame URL", () => {
    expect(routeFrameRequest(SCOPE, SCOPE).kind).toBe("not-found");
    expect(routeFrameRequest(SCOPE, `${SCOPE}sid`).kind).toBe("not-found");
    expect(routeFrameRequest(SCOPE, `${SCOPE}sid/agents/c/x`).kind).toBe(
      "not-found",
    );
    // A frame's absolute path, outside the scope.
    expect(routeFrameRequest(SCOPE, "/api/prototypes/a/x.css").kind).toBe(
      "not-found",
    );
  });

  test("an encoded traversal or separator is refused", () => {
    for (const segment of [
      "%2e%2e",
      "%2E",
      "a%2Fb",
      "a%5Cb",
      "a%00",
      "%E0%A4%A",
    ]) {
      expect(
        routeFrameRequest(SCOPE, `${SCOPE}sid/api/prototypes/${segment}/x`),
      ).toEqual({ kind: "bad-path", segment });
    }
  });

  test("the URL parser folds a literal traversal out of the scope", () => {
    const { pathname } = new URL(
      `http://h${SCOPE}sid/api/prototypes/../../../../x`,
    );
    expect(routeFrameRequest(SCOPE, pathname).kind).toBe("not-found");
  });
});

describe("frame scopes", () => {
  test("the scope is the frames/ dir beside the script", () => {
    expect(framesScope("http://h/artifacts/host-x/frames-sw.js")).toBe(
      "http://h/artifacts/host-x/frames/",
    );
  });

  test("any build's frame scope is recognised, nothing else", () => {
    expect(isFramesScope("http://h/artifacts/host-old/frames/")).toBe(true);
    expect(isFramesScope("http://h/artifacts/host-old/")).toBe(false);
    expect(isFramesScope("http://h/frames/")).toBe(false);
  });
});
