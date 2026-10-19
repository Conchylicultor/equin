import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prototypesDir } from "@plugins/apps/plugins/prototypes/data-dirs";
import { fileHint } from "@plugins/framework/plugins/tooling/plugins/guards/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/core";

const GUIDE = "prototypes/CLAUDE.md";

/**
 * Prototypes live outside the checkout, where Claude Code never loads a
 * CLAUDE.md, and an agent can reach one from any task (an Improve report, a
 * follow-up) without a prompt pointing at the guide. So the guide comes to the
 * agent the first time it touches a prototype's files.
 */
export default fileHint({
  name: "prototype-guide",
  // Only a prototype's own folder: `_history/`, `_picks/`, … are the app's.
  match: (p) => {
    const root = `${prototypesDir.path}/`;
    return p.startsWith(root) && !p.slice(root.length).startsWith("_");
  },
  once: true,
  message: [
    `This file is part of a prototype. Their guide, \`${GUIDE}\`, follows:`,
    "",
    readFileSync(join(REPO_ROOT, GUIDE), "utf8"),
  ].join("\n"),
});
