import { describe, expect, test } from "bun:test";
import { ASSET_PATH } from "@plugins/infra/plugins/endpoints/core";
import {
  hostResizedAsset,
  isResizableName,
  parseEdge,
  snapEdge,
} from "./endpoints";

describe("snapEdge", () => {
  test("rounds up to the next edge", () => {
    expect(snapEdge(1)).toBe(160);
    expect(snapEdge(160)).toBe(160);
    expect(snapEdge(161)).toBe(320);
    expect(snapEdge(1000)).toBe(1280);
  });
  test("caps at the largest edge", () => {
    expect(snapEdge(9000)).toBe(2560);
  });
});

test("parseEdge accepts only the closed set", () => {
  expect(parseEdge("640")).toBe(640);
  expect(parseEdge("641")).toBeNull();
  expect(parseEdge("")).toBeNull();
});

test("isResizableName", () => {
  expect(isResizableName("a.JPG")).toBe(true);
  expect(isResizableName("a.png")).toBe(true);
  expect(isResizableName("a.svg")).toBe(false);
  expect(isResizableName("a.gif")).toBe(false);
  expect(isResizableName("jpg")).toBe(false);
});

test("hostResizedAsset snaps the edge and names the version", () => {
  const asset = hostResizedAsset("/p/a b.jpg", 300, {
    mtimeMs: 12.5,
    size: 99,
  });
  const url = new URL(asset[ASSET_PATH], "http://x");
  expect(url.pathname).toBe("/api/host-fs/image/resized");
  expect(url.searchParams.get("path")).toBe("/p/a b.jpg");
  expect(url.searchParams.get("edge")).toBe("320");
  expect(url.searchParams.get("v")).toBe("12.5-99");
});
