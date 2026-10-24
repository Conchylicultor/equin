import { describe, expect, it } from "bun:test";
import {
  effectiveColorMode,
  parseAppColorModeOverride,
  parseConfiguredColorMode,
} from "./config";

describe("effectiveColorMode", () => {
  it("is the global setting where no app owns the document", () => {
    expect(effectiveColorMode("light", undefined)).toBe("light");
  });

  it("keeps an app's declared default unless the user overrides it", () => {
    expect(
      effectiveColorMode("dark", { declared: undefined, override: "default" }),
    ).toBe("dark");
    expect(
      effectiveColorMode("dark", { declared: "global", override: "default" }),
    ).toBe("dark");
    expect(
      effectiveColorMode("dark", { declared: "system", override: "default" }),
    ).toBe("system");
  });

  it("lets the override win, `global` included", () => {
    expect(
      effectiveColorMode("dark", { declared: "system", override: "light" }),
    ).toBe("light");
    expect(
      effectiveColorMode("light", { declared: "system", override: "global" }),
    ).toBe("light");
    expect(
      effectiveColorMode("dark", { declared: undefined, override: "system" }),
    ).toBe("system");
  });
});

describe("color-mode parsing", () => {
  it("throws on a value outside the closed sets", () => {
    expect(parseConfiguredColorMode("system")).toBe("system");
    expect(() => parseConfiguredColorMode("default")).toThrow();
    expect(parseAppColorModeOverride("global")).toBe("global");
    expect(() => parseAppColorModeOverride("blue")).toThrow();
  });
});
