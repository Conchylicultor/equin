import type { MachineFeature } from "@plugins/infra/plugins/endpoints/core";
import {
  attemptRows,
  conversationsActive,
  conversationsById,
  pushRows,
  taskRows,
} from "@plugins/tasks/plugins/tasks-core/core";
import { attemptWork } from "@plugins/tasks/plugins/attempt-work/core";
import { attemptSourceUrl } from "@plugins/tasks/plugins/task-source-url/core";
import { taskTracks } from "@plugins/tasks/plugins/task-track/core";
import { taskAutoStart } from "@plugins/tasks/plugins/auto-start/core";
import { taskShortTitles } from "@plugins/tasks/plugins/task-title/core";
import { outcomeReportRows } from "@plugins/tasks/plugins/outcome-report/core";
import { automationsCatalog } from "@plugins/tasks/plugins/automations/core";
import { queueRanks } from "@plugins/conversations/plugins/conversations-view/plugins/queue/core";
import { jsonlEvents } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";
import {
  subagentActivity,
  subagentTranscript,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/core";
import { conversationNoteRows } from "@plugins/conversations/plugins/conversation-view/plugins/notes/core";
import { turnSummaryRows } from "@plugins/conversations/plugins/conversation-view/plugins/turn-summary/core";
import { allowFiles } from "@plugins/conversations/plugins/conversation-view/plugins/allow-monitor/core";
import { editedFiles } from "@plugins/conversations/plugins/conversation-view/plugins/code/core";
import { spawnFailureRows } from "@plugins/conversations/plugins/spawn-failure/core";
import { conversationTurns } from "@plugins/conversations/plugins/turn-ledger/core";
import { conversationProgressRows } from "@plugins/conversations/plugins/conversation-progress/core";
import { conversationPrepromptRows } from "@plugins/conversations/plugins/conversation-preprompt/core";
import { conversationCategories } from "@plugins/conversations/plugins/conversation-category/core";
import { modelCatalog } from "@plugins/conversations/plugins/model-provider/core";
import {
  agentLaunchRows,
  agentRows,
} from "@plugins/conversations/plugins/agents/core";
import { sdkBundledCli } from "@plugins/conversations/plugins/runtime-sdk/core";
import { claudeCodeStatus } from "@plugins/infra/plugins/claude-cli/plugins/availability/core";
import { machineSleep } from "@plugins/infra/plugins/host/plugins/machine-sleep/core";
import { usageStats } from "@plugins/primitives/plugins/usage-rank/core";
import { customColumnValues } from "@plugins/primitives/plugins/data-view/plugins/custom-columns/plugins/values/core";
import {
  opsHistory,
  opsInFlight,
} from "@plugins/debug/plugins/profiling/plugins/op-log/plugins/op-store/core";
import {
  pluginFacetsTree,
  pluginTree,
} from "@plugins/plugin-meta/plugins/plugin-view/core";

/** A live declaration as the coverage test reads it: its key, and whether only the computer serves it. */
export interface DemoRead {
  readonly key: string;
  readonly needsMachine?: MachineFeature | undefined;
}

/**
 * Every live read the demo renders, imported (a rename is a tsc error). Each
 * one is either served by the demo's browser host or declares `needsMachine`
 * (the app renders it "not available") — asserted by
 * `bin/browser-host.test.ts` against the booted host graph. Config's reads are
 * not here: they are still answered page-side (`config_v2`'s Demo.Resource)
 * until the config split. A latent read joins the list when it becomes
 * visible in the demo.
 */
export const DEMO_READS: readonly DemoRead[] = [
  // The stories: tasks, attempts, conversations, pushes, queue, transcripts.
  taskRows,
  attemptRows,
  pushRows,
  conversationsActive,
  conversationsById,
  queueRanks,
  jsonlEvents,
  attemptSourceUrl,
  // DB-backed side tables, served by their portable server/.
  taskTracks,
  taskAutoStart,
  taskShortTitles,
  outcomeReportRows,
  conversationNoteRows,
  turnSummaryRows,
  spawnFailureRows,
  conversationTurns,
  conversationProgressRows,
  conversationPrepromptRows,
  conversationCategories,
  modelCatalog,
  agentRows,
  agentLaunchRows,
  usageStats,
  customColumnValues,
  // The computer's: needsMachine, rendered "not available".
  attemptWork,
  automationsCatalog,
  subagentActivity,
  subagentTranscript,
  allowFiles,
  editedFiles,
  sdkBundledCli,
  claudeCodeStatus,
  machineSleep,
  opsInFlight,
  opsHistory,
  pluginTree,
  pluginFacetsTree,
];
