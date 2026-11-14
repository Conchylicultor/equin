import { describe, it, expect } from "bun:test";

import { both, defineTokenGroup } from "./define-token-group";
import { paintedTokenGroups } from "./painted-token-groups";
import { resolveTheme } from "./resolve-theme";
import { subThemeBlocks } from "./paint";
import { defineSubTheme } from "./sub-theme";
import { defineTheme, type Theme } from "./theme";

const palette = defineTokenGroup("painted-test-palette", {
  primary: { default: "blue" },
});
const scale = defineTokenGroup("painted-test-scale", {
  fontSizeBody: { default: "1rem" },
});

const site = defineTheme({
  id: "painted-test-site",
  label: "Site",
  fragments: [palette.fragment(both({ primary: "azure" }))],
});
const page = defineSubTheme({
  id: "painted-test-page",
  label: "Page",
  fragments: [scale.fragment(both({ fontSizeBody: "1.125rem" }))],
});

describe("paintedTokenGroups", () => {
  it("returns the registered list itself when every named group is registered", () => {
    const registered = [palette, scale];
    expect(paintedTokenGroups(registered, [site, page])).toBe(registered);
  });

  it("adds the groups a code theme names that nothing registered", () => {
    const painted = paintedTokenGroups([palette], [site, page]);
    expect(painted.map((g) => g.id)).toEqual([palette.id, scale.id]);
  });

  // The equin.ai burst: every token-group plugin failed to load while the
  // site's themes did — no group registered at all.
  it("lets a code theme resolve with no group registered, dropping nothing", () => {
    const groups = paintedTokenGroups([], [site, page]);
    const { theme, skipped } = resolveTheme(
      site.id,
      new Map([[site.id, site]]),
      groups,
    );
    expect(skipped).toEqual([]);
    expect(theme.groups[palette.id]!.light.primary).toBe("azure");
    expect(subThemeBlocks([page], groups).skipped).toEqual([]);
  });

  it("still reports a stored theme naming a group no code defines", () => {
    const stored: Theme = {
      id: "custom:x",
      label: "x",
      source: "custom",
      fragments: [
        { groupId: "painted-test-retired", light: { a: "1" }, dark: {} },
      ],
    };
    const groups = paintedTokenGroups([palette], [site]);
    const { skipped } = resolveTheme(
      stored.id,
      new Map([[stored.id, stored]]),
      groups,
    );
    expect(skipped).toEqual([
      {
        reason: "unregistered-group",
        themeId: "custom:x",
        groupId: "painted-test-retired",
      },
    ]);
  });
});
