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
    "",
    "TERSE. Big paragraphs cost context in every session that loads it; agents are smart.",
    "Re-read what you wrote: is everything necessary, or can the point be expressed more simply?",
    "",
    "Terse content, not squeezed layout. Keep bullets, snippets in code blocks, ...",
  ].join("\n"),
});
