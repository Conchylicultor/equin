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

/** First non-empty line of a card's text, trimmed to a notification-friendly length. */
function cardSummary(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  const trimmed = firstLine.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
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

/**
 * Title + detail for the post-submit notification. The title states the action;
 * the description names the specific task(s) — plus whatever the launch options
 * say about themselves — so the bell entry is self-explanatory rather than a
 * bare verb. The host reads no option by name: it once branched on the
 * auto-start value to say "queued" vs "created", which put one option's
 * vocabulary into generic chrome.
 */
export function describeOutcome(
  outcome: SubmitOutcome,
  cards: CardDraft[],
  options: readonly LaunchOptionInfo[],
): { title: string; description: string } {
  if (cards.length === 1) {
    const card = cards[0]!;
    const parts = [cardSummary(card.text), ...optionSummaries(card, options)];
    return {
      title: "Task created",
      description: parts.filter(Boolean).join(" · "),
    };
  }
  const summaries = cards
    .map((c) => cardSummary(c.text))
    .filter(Boolean)
    .join(" → ");
  return {
    title: `${outcome.totalCount} tasks created`,
    description: summaries,
  };
}
