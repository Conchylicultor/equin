import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_STYLESHEET_PATH } from "../../core/app-stylesheet";
import {
  COLOR_SCHEME_ATTR,
  DARK_SCHEME,
  ROOT_SCHEME_SELECTORS,
  themeScopeSelectors,
} from "../../core/theme-scope";

// The nearest-carrier semantics of the scheme selectors, matched by the DOM's
// own selector engine, and the Tailwind `dark:` variant kept equal to them.

/** A chain of nested elements, outermost first; `null` = no carrier. */
function chain(schemes: ("light" | "dark" | null)[]): HTMLElement {
  document.body.replaceChildren();
  let parent: HTMLElement = document.body;
  for (const scheme of schemes) {
    const el = document.createElement("div");
    if (scheme !== null) el.setAttribute(COLOR_SCHEME_ATTR, scheme);
    el.setAttribute("data-theme-scope", "app:x");
    parent.appendChild(el);
    parent = el;
  }
  return parent;
}

const isDark = (schemes: ("light" | "dark" | null)[]) =>
  chain(schemes).matches(`*${DARK_SCHEME}`);

describe("DARK_SCHEME: the nearest carrier wins", () => {
  it.each([
    [["dark"], true],
    [["light"], false],
    [[null], false],
    [["dark", null], true],
    [["dark", "light"], false],
    [["dark", "light", null], false],
    [["light", "dark"], true],
    [["light", "dark", null, null], true],
    [["dark", "light", "dark"], true],
    [["light", "dark", "light"], false],
    [["dark", "dark", "light"], false],
    [["dark", "light", "light", "dark"], true],
    [["light", "dark", "light", "dark"], true],
    [["dark", "light", "dark", "light"], false],
    [["light", "dark", "light", "dark", "light"], false],
  ] as const)("%j → dark %s", (schemes, dark) => {
    expect(isDark([...schemes])).toBe(dark);
  });

  it("scoped blocks pick their dark half by the nearest carrier", () => {
    const { light, dark } = themeScopeSelectors("app:x");
    const el = chain(["dark", "light"]);
    expect(el.matches(light)).toBe(true);
    expect(el.matches(dark)).toBe(false);
    expect(chain(["light", "dark"]).matches(dark)).toBe(true);
  });

  it("the base theme is re-declared on every carrier, in its scheme", () => {
    const el = chain(["dark", "light"]);
    expect(el.matches(ROOT_SCHEME_SELECTORS.light)).toBe(true);
    expect(el.matches(ROOT_SCHEME_SELECTORS.dark)).toBe(false);
    const plain = chain(["dark", null]);
    expect(plain.matches(ROOT_SCHEME_SELECTORS.light)).toBe(false);
    expect(plain.matches(ROOT_SCHEME_SELECTORS.dark)).toBe(false);
  });
});

describe("app.css", () => {
  it("declares the dark variant as DARK_SCHEME", () => {
    const css = readFileSync(
      join(__dirname, "../../../../../../../../", APP_STYLESHEET_PATH),
      "utf8",
    );
    expect(css).toContain(`@custom-variant dark (&${DARK_SCHEME});`);
  });
});
