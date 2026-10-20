export { agentManagerDemo } from "./internal/scenario";
export {
  STORIES as DEMO_STORIES,
  DEMO_AGENTS,
  agentId as demoAgentId,
  agentLaunchId as demoAgentLaunchId,
  taskId as demoTaskId,
  attemptId as demoAttemptId,
  conversationId as demoConversationId,
  worktreePath as demoWorktreePath,
} from "./internal/stories";
export type { Story as DemoStory, DemoAgent } from "./internal/stories";
export { transcriptJsonl as demoTranscriptJsonl } from "./internal/transcripts";
