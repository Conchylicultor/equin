import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

// The Agent SDK picks how to run `pathToClaudeCodeExecutable` from its NAME:
// one ending in `.js` / `.mjs` / `.ts` / `.tsx` / `.jsx` is handed to a script
// runtime (`bun <path> …`), anything else is exec'd. A caller-named clone
// carries free text (a conversation's title), so a title ending in ".ts" made
// Bun parse the Mach-O binary as TypeScript and the agent died at launch
// (2026-11-10, four launches of one task). The `bin` a caller passes is always
// the native Claude Code executable, so its spawn is always that file itself,
// whatever the SDK inferred from its name.

/**
 * The spawn of the native executable `bin`, from what the SDK asked for: the
 * SDK's `command` / `args` are `bin` / `[...executableArgs, ...cliArgs]` for a
 * name it reads as native, and `<runtime>` / `[...executableArgs, bin,
 * ...cliArgs]` for one it reads as a script — the same argv once `bin` is
 * taken back out of it. Anything else is a change in the SDK: thrown.
 */
export function nativeSpawn(bin: string, spawn: SpawnOptions): SpawnOptions {
  if (spawn.command === bin) return spawn;
  const at = spawn.args.indexOf(bin);
  if (at === -1) {
    throw new Error(
      `claudeQuery: the Agent SDK spawns "${spawn.command}" without the executable ${bin} in its arguments — its spawn shape changed`,
    );
  }
  return {
    ...spawn,
    command: bin,
    args: [...spawn.args.slice(0, at), ...spawn.args.slice(at + 1)],
  };
}
