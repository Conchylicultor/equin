import { PROTOTYPES_DIR_DISPLAY } from "@plugins/infra/plugins/paths/plugins/display/core";
import type { PrototypeMeta } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import type { FrameLaunch } from "@plugins/apps/plugins/prototypes/plugins/canvas/web";
import { PROTOTYPES_CATEGORY_ID } from "@plugins/apps/plugins/prototypes/core";
import type { CounterpartKindMeta } from "../types";

/**
 * The agent launch behind the rail's Compare button when the prototype names
 * no counterpart (or names it malformed): an agent finds the real thing it
 * mocks and declares it — making it comparable first (an exhibit) when the
 * real thing exists but no kind can show it yet. The kinds' example lines come
 * from the registry, so the prompt names no kind.
 */
export function declareCounterpartLaunch(
  meta: PrototypeMeta,
  kinds: readonly CounterpartKindMeta[],
): FrameLaunch {
  return {
    draftKey: `prototype-mocks:${meta.name}`,
    title: "Add the real app to compare with",
    description:
      "Launch an agent to find what this prototype mocks in the real app and declare it, so the canvas can show it side by side.",
    placeholder:
      "Extra context (optional) — e.g. which screen or component it mocks…",
    getRequest: (userText) => {
      const parts = [
        declarePrompt(meta, kinds),
        ...(userText.trim() ? [`Additional context: ${userText.trim()}`] : []),
      ];
      return { prompt: parts.join("\n\n"), categoryId: PROTOTYPES_CATEGORY_ID };
    },
  };
}

function declarePrompt(
  meta: PrototypeMeta,
  kinds: readonly CounterpartKindMeta[],
): string {
  const file = `${PROTOTYPES_DIR_DISPLAY}/${meta.name}/index.html`;
  const declared =
    meta.mocks.kind === "malformed"
      ? `Its current \`<meta name="mocks">\` line is malformed (${meta.mocks.reason}) — fix it.`
      : 'It does not declare one yet (no `<meta name="mocks">` line).';
  return [
    `The prototype "${meta.title}" (\`${file}\`) should name the real app thing it is a mockup of, so the prototype canvas can show the real one beside it (Compare with Real app).`,
    declared,
    "",
    "1. Read the prototype, then find its real counterpart in this app: the screen (an in-app route) or the single component it mocks.",
    '2. Declare it by adding ONE line to the prototype\'s `<head>`, `<meta name="mocks" content="<kind>:<ref>" />`. The kinds this worktree knows:',
    ...kinds.map((k) => `   - ${k.label}: \`${k.example}\``),
    "3. If it mocks a component that is not in the exhibit catalog yet, add an exhibit for it (see `plugins/plugin-meta/plugins/exhibits/CLAUDE.md`) and declare that one; build so it exists on your branch.",
    "",
    "The prototype folder is outside the repo and shared by every worktree: edit it in place, do not commit it. Read `plugins/apps/plugins/prototypes/plugins/compare/CLAUDE.md` for the declaration's contract.",
  ].join("\n");
}
