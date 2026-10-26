import type {
  Check,
  CheckContext,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  CLAUDE_SETTINGS_REL_PATH,
  renderClaudeSettings,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { importClosure } from "@plugins/framework/plugins/tooling/plugins/import-closure/core";
import { getWorktreeRoot } from "@plugins/infra/plugins/spawn/core";
import { loadGuards } from "../core/load-guards";
import {
  agentPolicySettings,
  GUARD_SCRIPTS,
} from "@plugins/framework/plugins/tooling/plugins/guards/plugins/agent-policy/core";
import type { ToolMatcher } from "../core";

/** A tool name the matcher covers — for an MCP server, any of its tools. */
function sampleTool(m: ToolMatcher): string {
  return m.endsWith("__*") ? `${m.slice(0, -1)}any_tool` : m;
}

/**
 * Claude Code only runs the guard hook for tools its matcher names, so a guard
 * on a tool the matcher leaves out never runs — and nothing says so. Every
 * guard's matcher must be covered by the agent policy's (which both
 * `.claude/settings.json` and every app launch carry).
 */
const matcherCoversGuards: Check = {
  id: "guards:hook-matcher-covers-guards",
  description:
    "the agent policy's PreToolUse matcher covers every tool a guard (built-in or plugin-contributed) matches",
  async run() {
    const entry = agentPolicySettings().hooks.PreToolUse?.find((e) =>
      e.hooks.some((h) => h.command.includes(GUARD_SCRIPTS.preToolUse)),
    );
    if (!entry?.matcher)
      return {
        ok: false,
        message: `the agent policy has no PreToolUse hook running ${GUARD_SCRIPTS.preToolUse}: no guard runs.`,
        hint: "Restore the guard hook entry in guards/plugins/agent-policy/core/agent-policy.ts.",
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
      hint: "Add each to the PreToolUse matcher in guards/plugins/agent-policy/core/agent-policy.ts (an MCP server `mcp__<server>__*` as `mcp__<server>__.*`), then `./equin build`.",
    };
  },
};

/**
 * `.claude/settings.json`'s protection keys (`hooks`, `permissions.deny`) are
 * generated from the agent policy, so a hook or deny rule added by hand — which
 * would reach only an agent whose cwd is in the repo — fails here.
 */
const claudeSettingsInSync: Check = {
  id: "guards:claude-settings-in-sync",
  description:
    ".claude/settings.json's hooks and permissions.deny are exactly what the agent policy (guards/plugins/agent-policy/core/agent-policy.ts) renders",
  async run(ctx: CheckContext): Promise<CheckResult> {
    const repo = await ctx.repo();
    const actual = await repo.read(CLAUDE_SETTINGS_REL_PATH);
    if (actual !== null && actual === renderClaudeSettings(repo.root))
      return { ok: true };
    return {
      ok: false,
      message: `${CLAUDE_SETTINGS_REL_PATH} is ${actual === null ? "missing" : "out of sync with the agent policy"}`,
      hint: "Protections (hooks, deny rules) are declared in guards/plugins/agent-policy/core/agent-policy.ts so every app launch carries them too — edit there, then run `./equin build` and commit the file.",
    };
  },
};

const GUARDS_BIN = "plugins/framework/plugins/tooling/plugins/guards/bin";

/**
 * The PreToolUse entry point is a bootstrap that must run whatever state the
 * checkout's code is in: it loads the guard proper with a dynamic `import()`
 * and falls back to main's guard when that throws. A static import of any repo
 * module from the bootstrap puts that module in front of the fallback — one
 * half-done edit there and every tool call is refused again, the edit that
 * would fix it included. So its static closure is exactly its own two files.
 */
const bootstrapStandsAlone: Check = {
  id: "guards:bootstrap-builtins-only",
  description:
    "the PreToolUse bootstrap (guards/bin/guard.ts) statically loads no repo module but bin/bootstrap.ts — the guard proper is a dynamic import it can fall back from",
  async run() {
    const entry = `${GUARDS_BIN}/guard.ts`;
    const allowed = new Set([entry, `${GUARDS_BIN}/bootstrap.ts`]);
    const closure = await importClosure(await getWorktreeRoot(), entry, {
      dynamicImports: "cut",
    });
    const extra = [...closure.modules].filter((m) => !allowed.has(m));
    const external = [...closure.external.keys()];
    if (extra.length === 0 && external.length === 0) return { ok: true };
    const lines = [
      ...extra.map((m) => closure.importChain(m).join(" → ")),
      ...external.map((spec) => `npm: ${spec}`),
    ];
    return {
      ok: false,
      message: `the PreToolUse bootstrap statically loads modules a mid-edit checkout can break, so a broken one refuses every tool call:\n    ${lines.join("\n    ")}`,
      hint: 'Import only node: builtins in guards/bin/guard.ts and bin/bootstrap.ts; reach repo code through guard.ts\'s dynamic import("./hook").',
    };
  },
};

export default [
  matcherCoversGuards,
  claudeSettingsInSync,
  bootstrapStandsAlone,
];
