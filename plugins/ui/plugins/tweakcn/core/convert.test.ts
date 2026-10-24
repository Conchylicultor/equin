import { describe, it, expect } from "bun:test";

import { TokenGroupFragmentsSchema } from "@plugins/ui/plugins/theme-engine/core";
import { convertTweakcnTheme } from "./convert";

describe("convertTweakcnTheme", () => {
  it("maps a tweakcn theme onto token-group fragments, one per group it has values for", () => {
    const fragments = convertTweakcnTheme({
      theme: {
        radius: "0.5rem",
        "font-sans": "Inter, sans-serif",
        "font-mono": "JetBrains Mono, monospace",
      },
      light: {
        background: "oklch(1 0 0)",
        "card-foreground": "oklch(0.1 0 0)",
        "sidebar-primary": "oklch(0.4 0.1 250)",
        "chart-1": "oklch(0.6 0.2 30)",
        shadow: "0 1px 2px black",
        spacing: "0.25rem",
        "tracking-normal": "0.01em",
        // Not an equin token: dropped by the key maps.
        "not-a-token": "x",
      },
      dark: {
        background: "oklch(0.1 0 0)",
        "card-foreground": "oklch(0.9 0 0)",
        "sidebar-primary": "oklch(0.7 0.1 250)",
        "chart-1": "oklch(0.7 0.2 30)",
        shadow: "0 1px 2px white",
      },
    });

    expect(fragments).toEqual([
      {
        groupId: "color-palette",
        light: { background: "oklch(1 0 0)", cardForeground: "oklch(0.1 0 0)" },
        dark: {
          background: "oklch(0.1 0 0)",
          cardForeground: "oklch(0.9 0 0)",
        },
      },
      {
        groupId: "sidebar-palette",
        light: { sidebarPrimary: "oklch(0.4 0.1 250)" },
        dark: { sidebarPrimary: "oklch(0.7 0.1 250)" },
      },
      {
        // Mode-independent: radius from `theme`, spacing from `light`, both modes.
        groupId: "shape",
        light: { radius: "0.5rem", spacing: "0.25rem" },
        dark: { radius: "0.5rem", spacing: "0.25rem" },
      },
      {
        groupId: "shadow",
        light: { shadow: "0 1px 2px black" },
        dark: { shadow: "0 1px 2px white" },
      },
      {
        groupId: "chart",
        light: { "chart-1": "oklch(0.6 0.2 30)" },
        dark: { "chart-1": "oklch(0.7 0.2 30)" },
      },
      {
        groupId: "font-family",
        light: {
          fontSans: "Inter, sans-serif",
          fontMono: "JetBrains Mono, monospace",
          letterSpacing: "0.01em",
        },
        dark: {
          fontSans: "Inter, sans-serif",
          fontMono: "JetBrains Mono, monospace",
          letterSpacing: "0.01em",
        },
      },
    ]);
    // What it returns is exactly what a saved theme stores.
    expect(TokenGroupFragmentsSchema.parse(fragments)).toEqual(fragments);
  });

  it("leaves out a group tweakcn gave no values for, rather than an empty fragment", () => {
    const fragments = convertTweakcnTheme({
      theme: {},
      light: { primary: "red" },
      dark: { primary: "maroon" },
    });
    expect(fragments.map((f) => f.groupId)).toEqual(["color-palette"]);
  });
});
