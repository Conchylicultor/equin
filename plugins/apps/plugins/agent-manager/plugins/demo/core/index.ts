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
  promptOf as demoPromptOf,
  storyByKey as demoStoryByKey,
} from "./internal/stories";
export type { Story as DemoStory, DemoAgent } from "./internal/stories";
export {
  DEMO_PAGES,
  DEMO_PAGE_IDS,
  DARK_MODE_PAGE_WORK,
} from "./internal/pages";
export type { DemoContentBlock, DemoNode, DemoPage } from "./internal/pages";
export { transcriptJsonl as demoTranscriptJsonl } from "./internal/transcripts";
export type {
  PageSession as DemoPageSession,
  PageToolCall as DemoPageToolCall,
} from "./internal/transcripts";
export {
  demoPrototypeDataOf,
  demoPrototypeSeed,
  demoVersionFingerprint,
} from "./internal/prototypes";
export type {
  DemoPrototype,
  DemoPrototypeData,
  DemoPrototypeSeed,
  DemoPrototypeTree,
  DemoPrototypeVersion,
} from "./internal/prototypes";
