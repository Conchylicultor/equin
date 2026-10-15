import { describe, expect, it } from "vitest";

import { resolveUnmatchedUrl } from "../internal/unmatched-url";

// The ONE rule behind both the destructive `replaceState` redirect and the
// surface the tabs area paints. The redirect must never overwrite a URL that
// could still resolve — and must never overwrite a broken link either, since
// that destroys the only evidence of what went wrong.
describe("resolveUnmatchedUrl", () => {
  const base = {
    matched: false,
    home: "app" as const,
    isBareRoot: false,
    deferredComplete: true,
    anyAppShellLoadError: false,
  };

  it("a matched app renders normally", () => {
    expect(resolveUnmatchedUrl({ ...base, matched: true })).toBe("render");
  });

  it("no home app (the composition holds none) ⇒ nothing to canonicalize to", () => {
    expect(resolveUnmatchedUrl({ ...base, home: "none" })).toBe("render");
  });

  it("an unregistered home never redirects: wait, then name the failure", () => {
    const root = { ...base, isBareRoot: true, home: "unregistered" as const };
    expect(resolveUnmatchedUrl({ ...root, deferredComplete: false })).toBe(
      "loading",
    );
    expect(resolveUnmatchedUrl({ ...root, anyAppShellLoadError: true })).toBe(
      "load-error",
    );
    expect(resolveUnmatchedUrl(root)).toBe("home-missing");
  });

  it("bare root redirects immediately, regardless of load state", () => {
    expect(
      resolveUnmatchedUrl({
        ...base,
        isBareRoot: true,
        deferredComplete: false,
      }),
    ).toBe("redirect");
    expect(
      resolveUnmatchedUrl({
        ...base,
        isBareRoot: true,
        anyAppShellLoadError: true,
      }),
    ).toBe("redirect");
  });

  it("unmatched + still loading ⇒ wait (an app shell may still register)", () => {
    expect(resolveUnmatchedUrl({ ...base, deferredComplete: false })).toBe(
      "loading",
    );
  });

  it("unmatched + settled + a shell failed to load ⇒ app-load error", () => {
    expect(resolveUnmatchedUrl({ ...base, anyAppShellLoadError: true })).toBe(
      "load-error",
    );
  });

  // The behavior change: a settled, healthy, genuinely unmatched path used to
  // silently `replaceState` to the default app, landing the user on the homepage
  // with no explanation (e.g. a legacy `/tasks/t/<id>` link missing its `/agents`
  // prefix). It now keeps its URL and says so.
  it("unmatched + settled + healthy ⇒ not-found, never a redirect", () => {
    expect(resolveUnmatchedUrl(base)).toBe("not-found");
  });

  it("only bare root ever redirects", () => {
    const flags = [false, true];
    for (const isBareRoot of flags)
      for (const deferredComplete of flags)
        for (const anyAppShellLoadError of flags) {
          const outcome = resolveUnmatchedUrl({
            ...base,
            isBareRoot,
            deferredComplete,
            anyAppShellLoadError,
          });
          expect(outcome === "redirect").toBe(isBareRoot);
        }
  });
});
