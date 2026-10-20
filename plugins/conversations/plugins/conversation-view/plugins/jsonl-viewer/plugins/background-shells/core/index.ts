export type { ShellOutput } from "./protocol";
export {
  SHELL_OUTPUT_TAIL_BYTES,
  ShellFactSchema,
  ShellOutputSchema,
  conversationShellFacts,
  shellOutput,
} from "./protocol";
export type {
  BackgroundShell,
  BackgroundShellState,
  BackgroundShellsInput,
  ShellFact,
  ShellLaunch,
} from "./shells";
export {
  BASH_TOOL_NAME,
  SHELL_ID_PATTERN,
  backgroundShellsOf,
  exitCodeOfSummary,
  parseShellAck,
  shellFactsOf,
  shellsFromFacts,
  shellLaunchOf,
  shellLaunchesIn,
} from "./shells";
export { lastOutputLine, stripAnsi, terminalText } from "./output-text";
