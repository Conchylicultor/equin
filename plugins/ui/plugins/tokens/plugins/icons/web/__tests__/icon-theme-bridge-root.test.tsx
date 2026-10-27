import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// Before the surface has said which app owns `:root`, the root scope — and
// every sub-theme, resolved over it — publishes NOTHING: publishing the
// desktop's icon style meanwhile would draw the wrong family for a frame on a
// page an app opens. Once known, both publish the root app's style.

const root = vi.hoisted(() => ({
  state: { known: false } as
    { known: false } | { known: true; scopeId: string | undefined },
}));

const published = vi.hoisted(
  () => [] as { scope: string | undefined; values: unknown }[],
);

vi.mock("@plugins/apps-core/plugins/theme-scope/web", () => ({
  useRootThemeScopeState: () => root.state,
}));

vi.mock("@plugins/apps-core/web", () => ({
  Apps: { App: { useContributions: () => [] } },
}));

vi.mock("@plugins/config_v2/web", () => ({
  useScopeMembership: () => ({ status: "ready", data: false }),
}));

vi.mock("../../core", () => ({
  iconsGroup: { id: "icons" },
  readIconTokens: (values: unknown) => values,
}));

const sub = vi.hoisted(() => ({
  kind: "sub-theme" as const,
  id: "doc",
  label: "Doc",
  fragments: [
    {
      groupId: "icons",
      light: { iconFill: "filled" },
      dark: { iconFill: "filled" },
    },
  ],
}));

vi.mock("@plugins/ui/plugins/theme-engine/web", () => ({
  ThemeEngine: {
    FixedTheme: { useContributions: () => [] },
    SubTheme: { useContributions: () => [sub] },
    TokenGroup: { useContributions: () => [] },
  },
  useResolvedColorMode: () => "light",
  useResolvedTheme: (scopeId: string | undefined) => ({
    pending: false,
    theme: {
      groups: {
        icons: {
          light: { iconFamily: scopeId ?? "desktop" },
          dark: { iconFamily: scopeId ?? "desktop" },
        },
      },
    },
  }),
}));

vi.mock("@plugins/ui/plugins/icons/web", () => ({
  usePublishIconStyle: (scope: string | undefined, values: unknown) => {
    published.push({ scope, values });
  },
}));

import { IconThemeBridge } from "../components/icon-theme-bridge";

afterEach(() => {
  cleanup();
  published.length = 0;
  root.state = { known: false };
});

describe("IconThemeBridge's root and sub-theme scopes", () => {
  it("publish nothing while the root scope is not known", () => {
    render(<IconThemeBridge />);
    expect(published).toEqual([]);
  });

  it("publish the root app's style once it is known", () => {
    root.state = { known: true, scopeId: "app:website" };
    render(<IconThemeBridge />);
    expect(published).toContainEqual({
      scope: undefined,
      values: { iconFamily: "app:website" },
    });
    expect(published).toContainEqual({
      scope: "sub:doc",
      values: { iconFamily: "app:website", iconFill: "filled" },
    });
  });
});
