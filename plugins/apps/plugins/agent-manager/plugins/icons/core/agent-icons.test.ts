import { describe, expect, test } from "bun:test";
import type { SymbolName } from "@plugins/ui/plugins/icons/core";
import { agentIcons, type AgentGlyph } from "./agent-icons";

// Importing the family defines it: defineIconFamily has already checked every
// body (shape elements only) and every motion (kind, delay, origin).
describe("agentIcons", () => {
  const glyphNames = new Set(Object.keys(agentIcons.glyphs));

  test("is a fallback family over Lucide", () => {
    expect(agentIcons.id).toBe("agent");
    expect(agentIcons.coverage).toBe("fallback");
    expect(agentIcons.fallback).toBe("lucide");
  });

  test("draws the prototype's glyphs and the chrome's most-used names", () => {
    expect(glyphNames.size).toBe(112);
  });

  test("every symbols value is one of its glyphs", () => {
    for (const [name, glyph] of Object.entries(agentIcons.symbols)) {
      expect({ name, known: glyphNames.has(glyph) }).toEqual({
        name,
        known: true,
      });
    }
  });

  test("maps the agent manager's sidebar and core actions", () => {
    const expected: Partial<Record<SymbolName, AgentGlyph>> = {
      checklist: "list-checks",
      "precision-manufacturing": "bot",
      "chat-bubble": "message-square",
      insights: "chart-no-axes-column",
      folder: "folder",
      add: "plus",
      close: "x",
      "expand-more": "chevron-down",
      "keyboard-arrow-down": "chevron-down",
      search: "search",
      "content-copy": "copy",
      "auto-mode": "automation",
      settings: "settings",
      delete: "trash",
      refresh: "rotate-cw",
      replay: "rotate-ccw",
      warning: "triangle-alert",
      error: "circle-alert",
      info: "info",
      "account-tree": "workflow",
      "keyboard-arrow-up": "chevron-up",
      schedule: "clock",
    };
    const mapped = Object.fromEntries(
      Object.keys(expected).map((name) => [
        name,
        agentIcons.symbols[name as SymbolName],
      ]),
    );
    expect(mapped).toEqual(expected);
  });

  test("every glyph moves, and a draw part carries pathLength", () => {
    for (const [name, glyph] of Object.entries(agentIcons.glyphs)) {
      expect({ name, animated: glyph.animated }).toEqual({
        name,
        animated: true,
      });
    }
    expect(agentIcons.glyphs.check.body).toContain('pathLength="1"');
  });
});
