import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_STYLESHEET_PATH } from "../../core/app-stylesheet";
import {
  COLOR_SCHEME_ATTR,
  DARK_SCHEME_SCOPE,
  DARK_VARIANT_CSS,
  ROOT_SCHEME_SELECTORS,
  themeScopeSelectors,
} from "../../core/theme-scope";

// The scheme selectors' shape, and the Tailwind `dark:` variant kept equal to
// them. (The nearest-carrier semantics of `@scope … to …` is the browser's
// cascade, which jsdom does not implement — the scheme-regions e2e drives it.)

describe("scheme selectors", () => {
  it("puts a scoped block's dark half in the dark scope, on the root and below", () => {
    const { light, dark, darkScope } = themeScopeSelectors("app:x");
    expect(light).toBe('[data-theme-scope="app:x"]');
    expect(dark).toBe('[data-theme-scope="app:x"]:is(:scope, :scope *)');
    expect(darkScope).toBe(DARK_SCHEME_SCOPE);
    expect(DARK_SCHEME_SCOPE).toBe(
      `@scope ([${COLOR_SCHEME_ATTR}="dark"]) to ([${COLOR_SCHEME_ATTR}="light"])`,
    );
  });

  it("re-declares the base theme on every carrier, in its scheme, at zero specificity", () => {
    const carrier = (scheme: string) => {
      const el = document.createElement("div");
      el.setAttribute(COLOR_SCHEME_ATTR, scheme);
      return el;
    };
    expect(carrier("light").matches(ROOT_SCHEME_SELECTORS.light)).toBe(true);
    expect(carrier("light").matches(ROOT_SCHEME_SELECTORS.dark)).toBe(false);
    expect(carrier("dark").matches(ROOT_SCHEME_SELECTORS.dark)).toBe(true);
    expect(ROOT_SCHEME_SELECTORS.darkScope).toBeUndefined();
    expect(
      document.createElement("div").matches(ROOT_SCHEME_SELECTORS.light),
    ).toBe(false);
  });
});

describe("app.css", () => {
  it("declares the dark variant as DARK_VARIANT_CSS", () => {
    const css = readFileSync(
      join(__dirname, "../../../../../../../../", APP_STYLESHEET_PATH),
      "utf8",
    );
    expect(css).toContain(DARK_VARIANT_CSS);
  });
});
