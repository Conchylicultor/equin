import { agentModelGuard } from "./guards/agent-model";
import { backgroundOpsGuard } from "./guards/background-ops";
import { backgroundTimeoutGuard } from "./guards/background-timeout";
import { bunScriptGuard } from "./guards/bun-script";
import { claudeMdHint } from "./guards/claude-md-hint";
import { e2eToolUseIdGuard } from "./guards/e2e-tool-use-id";
import { findGuard } from "./guards/find";
import { gitDiffMainGuard } from "./guards/git-diff-main";
import { gitPushGuard } from "./guards/git-push";
import { gitResetMainGuard } from "./guards/git-reset-main";
import { mainEditsGuard } from "./guards/main-edits";
import { mainWritesGuard } from "./guards/main-writes";
import { noMemoryGuard } from "./guards/no-memory";
import { packageJsonHint } from "./guards/package-json-hint";
import { migrationsGuard } from "./guards/migrations";
import { pipefailGuard } from "./guards/pipefail";
import { pollLoopGuard } from "./guards/poll-loop";
import { postgresGuard } from "./guards/postgres";
import { rgReplaceGuard } from "./guards/rg-replace";
import type { Guard } from "./types";

export const GUARDS: Guard<any>[] = [
  // Bash
  findGuard,
  bunScriptGuard,
  rgReplaceGuard,
  gitDiffMainGuard,
  gitPushGuard,
  gitResetMainGuard,
  migrationsGuard,
  mainWritesGuard,
  postgresGuard,
  backgroundOpsGuard,
  pollLoopGuard,
  // Rewrites run after every judging guard, so those see what the agent typed.
  pipefailGuard,
  backgroundTimeoutGuard,
  e2eToolUseIdGuard,
  // File writes
  mainEditsGuard,
  // File hints
  packageJsonHint,
  claudeMdHint,
  // Bash + file writes
  noMemoryGuard,
  // Agent
  agentModelGuard,
];
