import {
  getEndpointErrorMessage,
  type FetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import type { Toast } from "@plugins/shell/plugins/notifications/web";
import { PROTOTYPES_DIR_DISPLAY } from "@plugins/infra/plugins/paths/plugins/display/core";
import { createPrototype } from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { OPTIONS_RULE } from "./launch-rules";

// The prompt every "New prototype" agent starts from. It is the one instruction
// that always reaches such an agent, so it carries the two rules that decide
// whether the result is an original design: start from the blank template, and
// never open a sibling. The rest is a pointer to `prototypes/CLAUDE.md` — this
// is a prompt, not the contract.
//
// The folder is minted BEFORE this text is written, so the prompt names it
// instead of asking for it: the agent is never asked to choose a name, and so
// cannot choose one wrong. What it IS asked for is the `<title>`, which is the
// prototype's only human name now that the folder is an opaque id.
export function newPrototypePrompt(id: string): string {
  return [
    `Design a new throwaway UI prototype in \`${PROTOTYPES_DIR_DISPLAY}/${id}/\`.`,
    "",
    "That folder ALREADY EXISTS and already holds the blank template — edit it in",
    `place. Do not create a second folder, and do not rename this one: \`${id}\` is a`,
    "minted id, not a name. The prototype's name is its `<title>`, which is what",
    "the gallery card and the pane header show — write a real one as you go.",
    "",
    "That directory is NOT in the repo, and that is deliberate: write the files",
    "there directly, do not commit anything, and do not create anything under the",
    "repo's `prototypes/`. Every worktree and main serve that one shared directory,",
    "so the prototype is visible the moment you save it — no build, no push.",
    "",
    "Read `prototypes/CLAUDE.md` (in the repo) first — it is the full contract.",
    "",
    "Design from a blank page. Do NOT open any other prototype's folder, and do",
    "not read `plugins/` — the app's own components and tokens are not a starting",
    "point here.",
    "",
    "Keep the folder self-contained and flat: one `index.html` plus whatever flat",
    "files it needs, referenced relatively. It must render when you double-click it",
    "straight off disk (`file://`), so write your JSX inline in `index.html` —",
    "Babel fetches an external `src` over XHR, which the browser blocks on `file://`.",
    "",
    OPTIONS_RULE,
  ].join("\n");
}

/**
 * Mint the folder the agent is about to be handed — before the conversation
 * that will edit it exists.
 *
 * Ordering matters: `getRequest` is awaited before `createConversation` is
 * called, so a failed mint rejects and the launch never happens. That is the
 * point — an agent must never be handed a prompt naming a folder that is not
 * there. The toast is what the user sees at the button; re-throwing is what
 * aborts the launch (and reaches the crash collector, which files a report).
 * The mint goes through the caller's `fetchEndpoint` (`useFetchEndpoint()`), and
 * the failure is toasted through the caller's `toast` (`useToast()`).
 */
export async function mintPrototypeFolder(
  fetchEndpoint: FetchEndpoint,
  toast: Toast,
): Promise<string> {
  try {
    const { id } = await fetchEndpoint(createPrototype, {}, { body: {} });
    return id;
  } catch (err) {
    toast({
      type: "prototype",
      title: "Could not create the prototype",
      description: getEndpointErrorMessage(err),
      variant: "error",
    });
    throw err;
  }
}
