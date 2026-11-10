import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// The root publishes the desktop's style — `:root` never follows the focused
// app — and a sub-theme publishes a LAYER of only the tokens it names, worn by
// the icons primitive over whatever scope encloses its region.

const published = vi.hoisted(
  () => [] as { scope: string | undefined; values: unknown; layer?: true }[],
);

vi.mock("@plugins/apps-core/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Apps: { App: { useContributions: () => [] } },
}));

vi.mock("@plugins/config_v2/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useScopeMembership: () => ({ status: "ready", data: false }),
}));

vi.mock("../../core", () => ({
  iconsGroup: { id: "icons" },
  readIconTokens: (values: unknown) => values,
  readIconTokenLayer: (values: unknown) => values,
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

vi.mock("@plugins/ui/plugins/theme-engine/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
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

vi.mock("@plugins/ui/plugins/icons/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usePublishIconStyle: (scope: string | undefined, values: unknown) => {
    published.push({ scope, values });
  },
  usePublishIconStyleLayer: (scope: string, values: unknown) => {
    published.push({ scope, values, layer: true });
  },
}));

import { IconThemeBridge } from "../components/icon-theme-bridge";

afterEach(() => {
  cleanup();
  published.length = 0;
});

describe("IconThemeBridge's root and sub-theme scopes", () => {
  it("publishes the desktop's style for the root and the sub-theme's own tokens as a layer", () => {
    render(<IconThemeBridge />);
    expect(published).toContainEqual({
      scope: undefined,
      values: { iconFamily: "desktop" },
    });
    expect(published).toContainEqual({
      scope: "sub:doc",
      values: { iconFill: "filled" },
      layer: true,
    });
  });
});
