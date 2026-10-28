// Shared CLI machinery, not a command (no default export): the CLI mapper runs
// a hand-off op through this when the guard exported a foreground deadline.
export { runHandedOff } from "./handoff";
