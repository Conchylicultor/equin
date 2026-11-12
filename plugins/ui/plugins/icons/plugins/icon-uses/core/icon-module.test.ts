import { describe, expect, it } from "bun:test";
import { isIconRefModule } from "./icon-module";

describe("isIconRefModule", () => {
  it("accepts the core barrel alias from anywhere", () => {
    expect(
      isIconRefModule(
        "plugins/tasks/web/a.tsx",
        "@plugins/ui/plugins/icons/core",
      ),
    ).toBe(true);
  });

  it("accepts relative paths into the icons core from inside the plugin", () => {
    const core = "plugins/ui/plugins/icons/core";
    expect(isIconRefModule(`${core}/nav-icons.ts`, "./icon-ref")).toBe(true);
    expect(
      isIconRefModule(`/abs/repo/${core}/nav-icons.ts`, "./icon-ref.ts"),
    ).toBe(true);
    expect(
      isIconRefModule(
        "plugins/ui/plugins/icons/web/internal/icon.tsx",
        "../../core",
      ),
    ).toBe(true);
    expect(
      isIconRefModule(
        "plugins/ui/plugins/icons/web/internal/icon.tsx",
        "../../core/index",
      ),
    ).toBe(true);
  });

  it("rejects other modules", () => {
    expect(isIconRefModule("plugins/tasks/web/a.tsx", "./other")).toBe(false);
    expect(
      isIconRefModule(
        "plugins/tasks/web/a.tsx",
        "@plugins/ui/plugins/icons/web",
      ),
    ).toBe(false);
    expect(
      isIconRefModule("plugins/ui/plugins/icons/core/a.ts", "./style"),
    ).toBe(false);
    expect(isIconRefModule("plugins/tasks/web/a.tsx", "react")).toBe(false);
  });
});
