import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Check } from "@plugins/framework/plugins/tooling/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { loadGuards } from "../core/load-guards";
import type { ToolMatcher } from "../core";

const GUARD_HOOK = "guards/bin/guard.ts";

const SettingsSchema = z.object({
  hooks: z.object({
    PreToolUse: z.array(
      z.object({
        matcher: z.string(),
        hooks: z.array(z.object({ command: z.string() })),
      }),
    ),
  }),
});

/** A tool name the matcher covers — for an MCP server, any of its tools. */
function sampleTool(m: ToolMatcher): string {
  return m.endsWith("__*") ? `${m.slice(0, -1)}any_tool` : m;
}

/**
 * Claude Code only runs the guard hook for tools its `.claude/settings.json`
 * matcher names, so a guard on a tool the matcher leaves out never runs — and
 * nothing says so. Every guard's matcher must be covered by it.
 */
const check: Check = {
  id: "guards:hook-matcher-covers-guards",
  description:
    "the PreToolUse matcher in .claude/settings.json covers every tool a guard (built-in or plugin-contributed) matches",
  async run() {
    const root = await getWorktreeRoot();
    const settings = SettingsSchema.parse(
      JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")),
    );
    const entry = settings.hooks.PreToolUse.find((e) =>
      e.hooks.some((h) => h.command.includes(GUARD_HOOK)),
    );
    if (!entry)
      return {
        ok: false,
        message: `.claude/settings.json has no PreToolUse hook running ${GUARD_HOOK}: no guard runs.`,
        hint: "Restore the guard hook entry in .claude/settings.json.",
      };
    // Claude Code reads a matcher with non-word characters as a regex over the
    // tool name; anchored here, the strictest reading.
    const covers = new RegExp(`^(?:${entry.matcher})$`);
    const missing = new Map<string, string[]>();
    for (const guard of await loadGuards()) {
      const matchers = Array.isArray(guard.matcher)
        ? guard.matcher
        : [guard.matcher];
      for (const m of matchers) {
        if (covers.test(sampleTool(m))) continue;
        missing.set(m, [...(missing.get(m) ?? []), guard.name]);
      }
    }
    if (missing.size === 0) return { ok: true };
    const lines = [...missing].map(
      ([m, names]) => `${m} (guards: ${names.join(", ")})`,
    );
    return {
      ok: false,
      message: `the guard hook's matcher "${entry.matcher}" leaves out tools guards match, so those guards never run:\n    ${lines.join("\n    ")}`,
      hint: "Add each to the PreToolUse matcher in .claude/settings.json (an MCP server `mcp__<server>__*` as `mcp__<server>__.*`).",
    };
  },
};

export default check;
