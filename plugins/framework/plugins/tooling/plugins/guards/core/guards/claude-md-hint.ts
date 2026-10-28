import { fileHint } from "../file-hint";

export const claudeMdHint = fileHint({
  name: "agent-docs",
  match: (p) =>
    p.endsWith("/CLAUDE.md") ||
    p.endsWith("/AGENTS.md") ||
    p.endsWith("/DESIGN.md"),
  tools: ["Write", "Edit"],
  message: [
    "Agent docs:",
    "- CLAUDE.md (always loaded): what you need to follow the rules — rules, contracts, gotchas, where things live.",
    "- DESIGN.md (on demand, same headings): what you need to change a rule — why, rejected alternatives, limits.",
    "- Neither: history, ids, dates, test lists (git, the tests), plans (research/).",
    "Keep it terse: high level only, let the reader infer the rest. Terse content, not squeezed layout — format snippets properly, use bullets.",
  ].join("\n"),
});
