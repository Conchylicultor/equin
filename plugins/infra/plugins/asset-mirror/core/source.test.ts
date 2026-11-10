import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  AssetPinMismatchError,
  defineAssetMirrorSource,
  pinOf,
  remoteFileUrl,
  verifyPinnedBytes,
  sha256OfBytes,
} from "./source";
import { defineAssetMirrorPrewarm } from "./prewarm";

const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const base = "https://cdn.example.com/assets/";
const bytes = (s: string) => new TextEncoder().encode(s);

describe("defineAssetMirrorSource", () => {
  test("strips a trailing slash and keeps the pins", () => {
    const source = defineAssetMirrorSource({
      id: "m",
      remoteBaseUrl: base,
      files: { "a.ogg": hex("x") },
    });
    expect(source.remoteBaseUrl).toBe(base.slice(0, -1));
    expect(pinOf(source, "a.ogg")).toBe(hex("x"));
    expect(pinOf(source, "b.ogg")).toBeUndefined();
    expect(pinOf(source, "toString")).toBeUndefined();
  });

  test("refuses a malformed pin, a deep or traversing name, and an empty set", () => {
    const make = (files: Record<string, string>) => () =>
      defineAssetMirrorSource({ id: "m", remoteBaseUrl: base, files });
    expect(make({ "a.ogg": "abc" })).toThrow("not a lowercase hex sha256");
    expect(make({ "a.ogg": hex("x").toUpperCase() })).toThrow("sha256");
    expect(make({ "a/b/c.ogg": hex("x") })).toThrow("one directory deep");
    expect(make({ "../a.ogg": hex("x") })).toThrow("one directory deep");
    expect(make({})).toThrow("at least one file");
  });
});

describe("verifyPinnedBytes", () => {
  const source = defineAssetMirrorSource({
    id: "m",
    remoteBaseUrl: base,
    files: { "a.ogg": hex("the reviewed bytes"), "PP C#1.ogg": hex("sharp") },
  });

  test("the pinned bytes pass", async () => {
    await verifyPinnedBytes(source, "a.ogg", bytes("the reviewed bytes"));
    await verifyPinnedBytes(source, "PP C#1.ogg", bytes("sharp"));
  });

  test("a file replaced under its name is refused", () => {
    expect(
      verifyPinnedBytes(source, "a.ogg", bytes("replaced upstream")),
    ).rejects.toThrow(AssetPinMismatchError);
  });

  test("an unpinned name is refused", () => {
    expect(verifyPinnedBytes(source, "other.ogg", bytes("x"))).rejects.toThrow(
      "not pinned",
    );
  });

  test("the remote URL encodes each segment", () => {
    expect(remoteFileUrl(source, "PP C#1.ogg")).toBe(
      "https://cdn.example.com/assets/PP%20C%231.ogg",
    );
    expect(remoteFileUrl(source, "en/data.json")).toBe(
      "https://cdn.example.com/assets/en/data.json",
    );
  });

  test("sha256OfBytes is the hex digest node:crypto gives", async () => {
    expect(await sha256OfBytes(bytes("abc"))).toBe(hex("abc"));
  });
});

describe("defineAssetMirrorPrewarm", () => {
  const source = defineAssetMirrorSource({
    id: "m",
    remoteBaseUrl: base,
    files: { "a.ogg": hex("a"), "b.ogg": hex("b") },
  });

  test("every pinned file by default, or the named subset with its pins", () => {
    expect(defineAssetMirrorPrewarm({ source }).files).toEqual(source.files);
    expect(
      defineAssetMirrorPrewarm({ source, files: ["b.ogg"] }).files,
    ).toEqual({ "b.ogg": hex("b") });
  });

  test("a name the source does not pin throws", () => {
    expect(() =>
      defineAssetMirrorPrewarm({
        source: source as typeof source & { files: Record<"c.ogg", string> },
        files: ["c.ogg"],
      }),
    ).toThrow("does not pin");
  });
});
