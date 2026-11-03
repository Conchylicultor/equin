import { describe, expect, test } from "bun:test";
import { armKeyCodec, KIND_RE } from "./arm-key";

describe("armKeyCodec", () => {
  test("encode prefixes the kind; decode strips it once", () => {
    const build = armKeyCodec("build");
    expect(build.encode("42")).toBe("build:42");
    expect(build.decode("build:42")).toBe("42");
  });

  test("a raw id containing `:` round-trips (the prefix is stripped once)", () => {
    const deploy = armKeyCodec("deploy");
    for (const raw of ["a:b", ":", "deploy:7", "", "x::y:"]) {
      expect(deploy.decode(deploy.encode(raw))).toBe(raw);
    }
  });

  test("another arm's key decodes to null", () => {
    const build = armKeyCodec("build");
    expect(build.decode("backup:42")).toBeNull();
    expect(build.decode("builds:42")).toBeNull();
    expect(build.decode("build")).toBeNull();
  });

  test("a kind KIND_RE refuses throws", () => {
    for (const kind of ["", "a:b", "a.b", "1x", "-x", "x y", "x'"]) {
      expect(KIND_RE.test(kind)).toBe(false);
      expect(() => armKeyCodec(kind)).toThrow(/plain identifier/);
    }
    for (const kind of ["build", "remote-deploy", "a_1"]) {
      expect(KIND_RE.test(kind)).toBe(true);
    }
  });
});
