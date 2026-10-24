import { useEffect } from "react";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { useActiveApp, usePathname } from "@plugins/apps-core/web";
import { useFocusedTabTitle } from "@plugins/apps-core/plugins/tabs/web";
import { useConfigResult } from "@plugins/config_v2/web";
import { foldResource } from "@plugins/primitives/plugins/live-state/web";
import {
  normalizeModelChoice,
  type ModelChoice,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  useStartThread,
  useThreadProgress,
  useThreadRuns,
} from "@plugins/conversations/plugins/agent-thread/web";
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
  type AskInput,
} from "../../core";
import { settleRestore, showRun, useAskState } from "./ask-store";

export const ASK_RESULTS = [askFiledTask];

/** The answering model once the settings are known, or why asking waits. */
interface AskSettings {
  model: ModelChoice | null;
  blocked: AskBlocked;
}

/** Why a question cannot be asked now; null when it can. */
export type AskBlocked = string | null;

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
  const app = useActiveApp();
  const path = usePathname();
  const tabTitle = useFocusedTabTitle();
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
    const input: AskInput = {
      app: app?.id ?? null,
      appName: app?.app.name ?? null,
      path,
      title: tabTitle ?? null,
      outline: formatOutline(
        collectOutline(document.body, { exclude: [card] }),
      ),
    };
    const result = await start({
      title: synthesiseTitleFallback(question.trim()),
      prompt: question,
      input,
    });
    if (result.kind !== "ok") {
      showToast({
        title: "equin can't be asked right now",
        description: result.message,
        variant: "error",
      });
      return false;
    }
    showRun(result.value.conversationId);
    return true;
  };

  return { ask, blocked };
}

/**
 * Once per page load, take back the newest Ask equin run as the pill when it
 * is still working or said something you have not seen — so a reload mid-run
 * keeps it, without covering the page. A run you have read stays in the Agent
 * Manager.
 */
export function useRestoreNewestRun(): void {
  const { restored } = useAskState();
  const runs = useThreadRuns(HELP_ASK_PROFILE, { limit: 1 });
  const newest =
    runs.status === "ready"
      ? (runs.data[0]?.id ?? null)
      : // A failed read has nothing to take back: the run (if any) is still
        // in the Agent Manager.
        runs.status === "error"
        ? null
        : undefined;
  const progress = useThreadProgress(
    restored || newest === undefined || newest === null ? null : newest,
    ASK_RESULTS,
  );
  // The run to take back (a conversation id), nothing (null), or not decided
  // yet (undefined) while the reads load.
  const decision: string | null | undefined =
    restored || newest === undefined
      ? undefined
      : newest === null
        ? null
        : progress.status === "ready"
          ? progress.data !== null &&
            (progress.data.state === "working" || progress.data.unseen)
            ? newest
            : null
          : progress.status === "error"
            ? null
            : undefined;
  useEffect(() => {
    if (decision !== undefined) settleRestore(decision);
  }, [decision]);
}
