import { describe, expect, test } from "bun:test";
import { resolveCompositionUnlisted } from "./unlisted";

const apps = new Map([
  ["home", { plugin: "apps.home.shell" }],
  ["file-explorer", { plugin: "apps.file-explorer.shell" }],
  ["mail", { plugin: "apps.mail.shell" }],
]);
const bundle = new Set(["apps.home.shell", "apps.file-explorer.shell"]);

describe("resolveCompositionUnlisted", () => {
  test("a bundled app other than the home may be unlisted", () => {
    expect(
      resolveCompositionUnlisted({
        apps,
        bundle,
        unlisted: ["file-explorer"],
        home: "home",
      }),
    ).toEqual({ kind: "ok", appIds: ["file-explorer"] });
  });

  test("no app, an unbundled app, the home or a repeat is refused", () => {
    for (const unlisted of [
      ["nope"],
      ["mail"],
      ["home"],
      ["file-explorer", "file-explorer"],
    ]) {
      expect(
        resolveCompositionUnlisted({ apps, bundle, unlisted, home: "home" })
          .kind,
      ).toBe("error");
    }
  });
});
