import { describe, expect, it } from "bun:test";
import { fileRefForPath } from "./file-ref-for-path";

describe("fileRefForPath", () => {
  it("reads a relative path from the workspace", () => {
    expect(fileRefForPath("att-1", "src/a.png")).toEqual({
      source: "workspace",
      workspace: "att-1",
      path: "src/a.png",
    });
  });

  it("relativizes an absolute path inside the known root", () => {
    expect(
      fileRefForPath("att-1", "/wt/one/src/a.png", { root: "/wt/one/" }),
    ).toEqual({ source: "workspace", workspace: "att-1", path: "src/a.png" });
  });

  it("sends an absolute path outside the root to the host", () => {
    expect(
      fileRefForPath("att-1", "/tmp/shot.png", { root: "/wt/one" }),
    ).toEqual({ source: "host", path: "/tmp/shot.png" });
  });

  it("does not take a sibling sharing the root's prefix for inside", () => {
    expect(
      fileRefForPath("att-1", "/wt/one-two/a.png", { root: "/wt/one" }),
    ).toEqual({ source: "host", path: "/wt/one-two/a.png" });
  });

  it("does not let `..` escape the root into a workspace read", () => {
    expect(
      fileRefForPath("att-1", "/wt/one/../etc/a.png", { root: "/wt/one" }),
    ).toEqual({ source: "host", path: "/wt/etc/a.png" });
  });

  it("sends an absolute path to the host when the root is unknown", () => {
    expect(fileRefForPath("main", "/wt/one/a.png")).toEqual({
      source: "host",
      path: "/wt/one/a.png",
    });
  });

  it("sends a ~ path to the host, unexpanded", () => {
    expect(
      fileRefForPath("att-1", "~/Desktop/a.png", { root: "/wt/one" }),
    ).toEqual({ source: "host", path: "~/Desktop/a.png" });
  });
});
