import { describe, expect, test } from "bun:test";
import { appRootOf } from "./app-root";

describe("appRootOf", () => {
  test("an app's own and nested plugins share its root", () => {
    expect(appRootOf("apps/plugins/website/plugins/shell")).toBe(
      "apps/plugins/website/",
    );
    expect(appRootOf("apps/plugins/website/plugins/pages/plugins/story")).toBe(
      "apps/plugins/website/",
    );
  });
  test("a plugin outside every app has none", () => {
    expect(appRootOf("menu-bar")).toBeNull();
    expect(appRootOf("apps-core/plugins/layout")).toBeNull();
    expect(appRootOf("apps")).toBeNull();
  });
});
