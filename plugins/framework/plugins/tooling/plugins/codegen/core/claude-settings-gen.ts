import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentPolicySettings } from "@plugins/framework/plugins/tooling/plugins/guards/plugins/agent-policy/core";
import { writeGenerated } from "./write-generated";

/**
 * The repo's Claude Code project settings. Its protection keys — `hooks` and
 * `permissions.deny` — are derived from the guards plugin's one declaration of
 * the agent policy (`agentPolicySettings`), which every app launch also
 * carries; every other key is the repo's own context, hand-owned and kept as
 * it is.
 */
export const CLAUDE_SETTINGS_REL_PATH = ".claude/settings.json";

export function claudeSettingsPath(root: string): string {
  return join(root, CLAUDE_SETTINGS_REL_PATH);
}

/** The settings file with its protection keys rewritten from the policy. */
export function renderClaudeSettings(root: string): string {
  const file = claudeSettingsPath(root);
  const current: Record<string, unknown> = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)
    : {};
  const policy = agentPolicySettings();
  const permissions = (current.permissions ?? {}) as Record<string, unknown>;
  const next = {
    ...current,
    permissions: { ...permissions, deny: policy.permissions.deny },
    hooks: policy.hooks,
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

export async function generateClaudeSettings({
  root,
}: {
  root: string;
}): Promise<void> {
  await writeGenerated({
    file: claudeSettingsPath(root),
    content: renderClaudeSettings(root),
  });
}
