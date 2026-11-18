import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { useActiveApp, usePathname } from "@plugins/apps-core/web";
import { useFocusedTabTitle } from "@plugins/apps-core/plugins/tabs/web";
import { useConfigResult } from "@plugins/config_v2/web";
import { foldResource } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  normalizeModelChoice,
  type ModelChoice,
} from "@plugins/conversations/plugins/model-provider/core";
import { useStartThread } from "@plugins/conversations/plugins/agent-thread/web";
import {
  collectOutline,
  formatOutline,
} from "@plugins/primitives/plugins/ui-context/web";
import { synthesiseTitleFallback } from "@plugins/tasks/plugins/task-title/core";
import { HELP_CATEGORY_ID } from "@plugins/hints/plugins/help-menu/core";
import {
  HELP_ASK_PROFILE,
  askConfig,
  askFiledTask,
  formatPageContext,
  pageKey,
  stripPageContext,
  type AskInput,
} from "../../core";
import { showRun } from "./ask-store";
import { askSeenPageStore } from "./stores";

export const ASK_RESULTS = [askFiledTask];

/** The answering model once the settings are known, or why asking waits. */
interface AskSettings {
  model: ModelChoice | null;
  blocked: AskBlocked;
}

/** Why a question cannot be asked now; null when it can. */
export type AskBlocked = string | null;

/**
 * Where the user is, captured on demand: the focused app, the route, the
 * focused tab's title and the page's outline (`card` — the Ask card itself —
 * left out). Read at the moment of a send, so it is the page the words were
 * typed on.
 */
function usePageContext(): (card: Element) => AskInput {
  const app = useActiveApp();
  const path = usePathname();
  const tabTitle = useFocusedTabTitle();
  return (card) => ({
    app: app?.id ?? null,
    appName: app?.app.name ?? null,
    path,
    title: tabTitle ?? null,
    outline: formatOutline(collectOutline(document.body, { exclude: [card] })),
  });
}

/** Record that run `conversationId`'s agent now knows the user is on `input`'s page. */
function markPageSent(conversationId: string, input: AskInput): void {
  // A refused write is already loud (the store's toast and report); the next
  // reply then carries the page again, which is harmless.
  askSeenPageStore.write(conversationId, pageKey(input));
}

/**
 * The thread's `prepareTurn`: a reply sent from another page than the agent
 * last heard of carries that page — a `<page-context>` token after the words
 * (drawn as a chip in the bubble), the same fields the first question's
 * context held. From the same page, the words go alone. A token already in
 * the words (a stopped turn's text, back in the draft) is dropped first, so
 * a turn never carries two.
 */
export function useAskPrepareTurn(
  conversationId: string,
  card: () => Element,
): (text: string) => string {
  const capture = usePageContext();
  return (typed) => {
    const text = stripPageContext(typed);
    const input = capture(card());
    const seen = askSeenPageStore.read(conversationId);
    if (seen.kind === "value" && seen.value === pageKey(input)) return text;
    markPageSent(conversationId, input);
    return `${text}\n\n${formatPageContext(input)}`;
  };
}

/**
 * Asking: the first question starts a run (a task in the Help category, under
 * the `help.ask` profile, on the configured model) with where the user is —
 * the focused app, the route, the focused tab's title and the page's outline
 * (`card` itself left out) — then shows it in the card.
 */
export function useAskQuestion(): {
  ask: (question: string, card: Element) => Promise<boolean>;
  blocked: AskBlocked;
} {
  const capture = usePageContext();
  const toast = useToast();
  const config = useConfigResult(askConfig);
  // The configured model, or why a question cannot be asked yet: every send
  // waits for the settings to be known, never runs on a stand-in model.
  const settings = foldResource(config, {
    loading: (): AskSettings => ({ model: null, blocked: "Loading settings…" }),
    error: (): AskSettings => ({
      model: null,
      blocked: "Ask equin's settings could not be read",
    }),
    ready: (c): AskSettings => ({
      model: normalizeModelChoice(c.model),
      blocked: null,
    }),
  });
  const { start, availability } = useStartThread({
    filedFrom: asPluginId("hints.ask"),
    profile: HELP_ASK_PROFILE,
    categoryId: HELP_CATEGORY_ID,
    // Read only once the settings are known: `blocked` holds every send until then.
    model: settings.model ?? "sonnet",
  });

  const blocked: AskBlocked = !availability.available
    ? availability.message
    : settings.blocked;

  const ask = async (question: string, card: Element): Promise<boolean> => {
    if (blocked !== null) return false;
    const input = capture(card);
    const result = await start({
      title: synthesiseTitleFallback(question.trim()),
      prompt: question,
      input,
    });
    if (result.kind !== "ok") {
      toast({
        type: "ask-start-failed",
        category: "conversations",
        title: "equin can't be asked right now",
        description: result.message,
        variant: "error",
      });
      return false;
    }
    markPageSent(result.value.conversationId, input);
    showRun(result.value.conversationId);
    return true;
  };

  return { ask, blocked };
}
