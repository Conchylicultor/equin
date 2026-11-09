import { describe, expect, it } from "bun:test";
import { locationForPath } from "./location-for-path";

describe("locationForPath", () => {
  it("reads a relative path from the workspace", () => {
    expect(locationForPath("att-1", "src/a.png")).toEqual({
      fs: "checkout",
      checkout: "att-1",
      path: "src/a.png",
    });
  });

  it("relativizes an absolute path inside the known root", () => {
    expect(
      locationForPath("att-1", "/wt/one/src/a.png", { root: "/wt/one/" }),
    ).toEqual({ fs: "checkout", checkout: "att-1", path: "src/a.png" });
  });

  it("sends an absolute path outside the root to the computer", () => {
    expect(
      locationForPath("att-1", "/tmp/shot.png", { root: "/wt/one" }),
    ).toEqual({ fs: "computer", path: "/tmp/shot.png" });
  });

  it("does not take a sibling sharing the root's prefix for inside", () => {
    expect(
      locationForPath("att-1", "/wt/one-two/a.png", { root: "/wt/one" }),
    ).toEqual({ fs: "computer", path: "/wt/one-two/a.png" });
  });

  it("does not let `..` escape the root into a workspace read", () => {
    expect(
      locationForPath("att-1", "/wt/one/../etc/a.png", { root: "/wt/one" }),
    ).toEqual({ fs: "computer", path: "/wt/etc/a.png" });
  });

  it("sends an absolute path to the computer when the root is unknown", () => {
    expect(locationForPath("main", "/wt/one/a.png")).toEqual({
      fs: "computer",
      path: "/wt/one/a.png",
    });
  });

  it("sends a ~ path to the computer, unexpanded", () => {
    expect(
      locationForPath("att-1", "~/Desktop/a.png", { root: "/wt/one" }),
    ).toEqual({ fs: "computer", path: "~/Desktop/a.png" });
  });
});
