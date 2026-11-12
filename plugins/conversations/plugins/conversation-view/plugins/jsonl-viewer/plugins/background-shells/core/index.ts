export type { ShellOutput } from "./protocol";
export {
  SHELL_OUTPUT_TAIL_BYTES,
  DeliveredShellFactSchema,
  ShellFactSchema,
  ShellOutputSchema,
  conversationShellFacts,
  shellOutput,
} from "./protocol";
export type {
  BackgroundShell,
  BackgroundShellState,
  BackgroundShellsInput,
  ConversationShellSet,
  DeliveredShell,
  DeliveredShellFact,
  ShellFact,
  ShellFacts,
  ShellLaunch,
} from "./shells";
export {
  BASH_TOOL_NAME,
  SHELL_ID_PATTERN,
  backgroundShellsOf,
  exitCodeOfSummary,
  parseShellAck,
  shellFactsOf,
  shellNotificationLabel,
  shellOutputFileIn,
  shellSetFromFacts,
  shellsFromFacts,
  shellLaunchOf,
  shellLaunchesIn,
} from "./shells";
export { lastOutputLine, stripAnsi, terminalText } from "./output-text";
