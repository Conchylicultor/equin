import { renderPrompt } from "@plugins/tasks/plugins/automations/core";
import { FILE_TASK_TOOL, type AskInput } from "../../core";
import { REPO_CONTEXT_DIR } from "./repo-context";

/** Where the user is, in words. */
function pageLine(input: AskInput): string {
  const app = input.appName ?? input.app;
  const where = app === null ? "no app" : `the ${app} app`;
  const title = input.title === null ? "" : `, looking at "${input.title}"`;
  return `The user is in ${where} (route \`${input.path}\`)${title}.`;
}

/**
 * The Ask equin agent's CLAUDE.md: `template` (the Instructions setting) filled
 * with where the user is and what is on their screen. A variable it names that
 * is not filled here fails the launch — never a prompt with a hole in it.
 */
export function askInstructions(
  template: string,
  input: AskInput,
  checkout: string,
): string {
  const rendered = renderPrompt(template, {
    page: pageLine(input),
    outline:
      input.outline.trim() === ""
        ? "(No named controls were found on the page.)"
        : input.outline,
    checkout,
    fileTaskTool: FILE_TASK_TOOL,
    repoContext: REPO_CONTEXT_DIR,
  });
  if (!rendered.ok) {
    throw new Error(
      `[hints.ask] the Ask equin instructions (Settings → Config → Ask equin) name unknown variables: ${rendered.unknown.map((n) => `{{${n}}}`).join(", ")}`,
    );
  }
  return rendered.text;
}
