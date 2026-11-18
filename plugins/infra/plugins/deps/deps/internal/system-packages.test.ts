import { describe, expect, test } from "bun:test";
import { missingPackages } from "./system-packages";

describe("missingPackages", () => {
  test("installed rows are present; removed, half-installed and unknown ones are missing", () => {
    const out = [
      "pkg-config\tinstall ok installed",
      "libgtk-3-dev:arm64\tinstall ok installed",
      "libsoup-3.0-dev\tdeinstall ok config-files",
      "libwebkit2gtk-4.1-dev\tinstall ok half-configured",
      "",
    ].join("\n");
    expect(
      missingPackages(out, [
        "pkg-config",
        "libgtk-3-dev",
        "libsoup-3.0-dev",
        "libwebkit2gtk-4.1-dev",
        "libjavascriptcoregtk-4.1-dev",
      ]),
    ).toEqual([
      "libsoup-3.0-dev",
      "libwebkit2gtk-4.1-dev",
      "libjavascriptcoregtk-4.1-dev",
    ]);
  });

  test("nothing reported: everything is missing", () => {
    expect(missingPackages("", ["a", "b"])).toEqual(["a", "b"]);
  });
});
