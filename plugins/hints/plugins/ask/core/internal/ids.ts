// The scratch profile an Ask equin run is launched under (the agent's
// CLAUDE.md, its tools) — the thread's kind, which `useThreadRuns` reads back.
export const HELP_ASK_PROFILE = "help.ask";

// The tool the help agent files a task with, by its own name (the transcript
// calls it `mcp__<server>__ask_file_task`). Reserved to the profile.
export const FILE_TASK_TOOL = "ask_file_task";
