import { describe, expect, test } from "bun:test";
import { localPathOf } from "./local-path";

const apps = [
  { basePath: "/about", formerBasePaths: ["/website"] },
  { basePath: "/deploy" },
];

describe("localPathOf", () => {
  test("a path under an app here is kept", () => {
    expect(localPathOf("/about", apps)).toBe("/about");
    expect(localPathOf("/about/vision", apps)).toBe("/about/vision");
  });
  test("a former base path moves to the app's current one", () => {
    expect(localPathOf("/website", apps)).toBe("/about");
    expect(localPathOf("/website/apps", apps)).toBe("/about/apps");
  });
  test("a prefix that is not a path segment does not match", () => {
    expect(localPathOf("/websites", apps)).toBeNull();
    expect(localPathOf("/aboutx", apps)).toBeNull();
  });
  test("no app here owns it", () => {
    expect(localPathOf("/mail", apps)).toBeNull();
  });
});
