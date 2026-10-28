import {
  getEndpointErrorMessage,
  type FetchEndpoint,
} from "@plugins/infra/plugins/endpoints/web";
import { extractAttachmentIds } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/web";
import type { CardDraft } from "../components/task-draft-form";
import {
  launchOptionValue,
  type LaunchOptionInfo,
} from "@plugins/tasks/plugins/launch-options/web";
import type { ToastArgs } from "@plugins/shell/plugins/notifications/web";
import { synthesiseTitleFallback } from "@plugins/tasks/plugins/task-title/core";
import { taskDetailRoute } from "@plugins/tasks/plugins/tasks-core/core";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  createTaskChain,
  type TaskChainRelate,
  type TaskChainSubmitBody,
  type TaskChainTarget,
} from "@plugins/tasks/core";

export interface SubmitArgs {
  cards: CardDraft[];
  target: TaskChainTarget;
  relate: TaskChainRelate | undefined;
  url: string;
  /** The open app's URL default, for cards whose URL toggle was never touched. */
  captureUrlDefault: boolean;
  /**
   * The live launch-option registry. Passed in rather than read here: reading
   * it is a hook, so it belongs in the submitting component and this stays a
   * pure function of an explicit list.
   */
  options: readonly LaunchOptionInfo[];
}

export interface SubmitOutcome {
  ok: boolean;
  errorMessage?: string;
  taskIds?: string[];
  totalCount: number;
}

export async function submitChain(
  fetchEndpoint: FetchEndpoint,
  args: SubmitArgs,
): Promise<SubmitOutcome> {
  const trimmed = args.cards.map((c) => ({ ...c, text: c.text.trim() }));
  const totalCount = trimmed.length;

  if (trimmed.some((c) => !c.text)) {
    return { ok: false, errorMessage: "All cards need text", totalCount };
  }

  const body: TaskChainSubmitBody = {
    target: args.target,
    relate: args.relate,
    cards: trimmed.map((c, i) => {
      const attachmentIds = Array.from(new Set(extractAttachmentIds(c.text)));
      return {
        text: c.text,
        // Every registered option, the card's choice or else its default —
        // resolved here, since the draft stores only choices. Values whose
        // option is no longer registered are never sent: a stale localStorage
        // draft must not 400 the whole submit.
        options: Object.fromEntries(
          args.options.map((o) => [o.id, launchOptionValue(c.options, o)]),
        ),
        url: (c.includeUrl ?? args.captureUrlDefault) ? args.url : undefined,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        linkedToPrev: i > 0 && !c.linkedToPrev ? false : undefined,
      };
    }),
  };

  try {
    const json = await fetchEndpoint(createTaskChain, {}, { body });
    return { ok: true, taskIds: json.taskIds, totalCount };
  } catch (err) {
    return {
      ok: false,
      errorMessage: `Submit failed: ${getEndpointErrorMessage(err)}`,
      totalCount,
    };
  }
}

/** A card's launch configuration, as the options themselves describe it. */
function optionSummaries(
  card: CardDraft,
  options: readonly LaunchOptionInfo[],
): string[] {
  return options.flatMap((o) => {
    const summary = o.summarize?.(launchOptionValue(card.options, o));
    return summary ? [summary] : [];
  });
}

/** Whether some option's value has this card's task start a conversation. */
function startsConversation(
  card: CardDraft,
  options: readonly LaunchOptionInfo[],
): boolean {
  return options.some(
    (o) => o.startsConversation?.(launchOptionValue(card.options, o)) === true,
  );
}

const addedIcon = symbol("add-task");

/**
 * The notification a submitted chain is worth, or null when it is worth
 * none.
 *
 * A task that starts a conversation of its own (a launch option says so —
 * auto-start, read through `startsConversation`, never by name) is announced
 * by that conversation, server-side ("Conversation started", once it
 * exists, so Open lands on it); the form says nothing for it. Every other
 * task is "Task added" (`N tasks added` for several) about the first of
 * them, by the title the server gave it, opening it in Tasks — no
 * conversation exists yet. The launch configuration is the developer detail.
 */
export function describeOutcome(
  outcome: SubmitOutcome,
  cards: CardDraft[],
  options: readonly LaunchOptionInfo[],
): ToastArgs | null {
  const added = cards.flatMap((card, i) => {
    const taskId = outcome.taskIds?.[i];
    if (taskId === undefined || startsConversation(card, options)) return [];
    return [{ card, taskId }];
  });
  const first = added[0];
  if (first === undefined) return null;
  const detail = added
    .map(({ card }) => optionSummaries(card, options).join(" · "))
    .filter(Boolean)
    .join(" → ");
  return {
    type: "task",
    category: "conversations",
    icon: addedIcon,
    title: added.length === 1 ? "Task added" : `${added.length} tasks added`,
    description: "",
    subjectId: first.taskId,
    // The title the server stored for it (Haiku may improve it later).
    subjectName: synthesiseTitleFallback(first.card.text),
    detail: detail || undefined,
    variant: "success",
    action: {
      kind: "open",
      payload: {
        to: taskDetailRoute.link(agentManagerApp, { taskId: first.taskId }),
      },
    },
  };
}
