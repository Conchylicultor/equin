import { fileHint } from "../file-hint";

export const claudeMdHint = fileHint({
  name: "claude-md-terse",
  match: (p) => p.endsWith("/CLAUDE.md") || p.endsWith("/AGENTS.md"),
  tools: ["Write", "Edit"],
  message: [
    "A CLAUDE.md is loaded into every future agent's context — every line costs.",
    "- Keep it terse.",
    "- Only keep what's useful for future agents",
    '- Keep the WHY when a rule looks wrong, so nobody "fixes" it back.',
    "- Don't document a bug you fixed structurally — if agents can't hit it anymore, the line only burns context.",
  ].join("\n"),
});
