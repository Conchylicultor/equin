import type { PluginId } from "@plugins/framework/plugins/plugin-id/core";
import { useState } from "react";
import { z } from "zod";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import {
  DEFAULT_DRAFT_TTL,
  useDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import {
  TaskDraftComposer,
  submitChain,
  useCaptureUrlDefault,
  useDraftPage,
} from "@plugins/tasks/plugins/task-draft-form/web";
import {
  TaskLaunch,
  type LaunchOptionValues,
} from "@plugins/tasks/plugins/launch-options/web";
import {
  Stack,
  insetClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { WISHES_CATEGORY_ID } from "../../core";

const filedIcon = symbol("check-circle");

/** What the user chose on the field besides its text: the launch options and the URL toggle. */
interface WishFieldChoices {
  /** Only the launch options the user changed; the rest resolve to their defaults. */
  options: LaunchOptionValues;
  /** Undefined until toggled: follows the app's URL default until then. */
  includeUrl?: boolean | undefined;
}

const wishTextStore = defineStore<string>({
  owner: "wish.field.text",
  label: "Wish field text",
  area: "local",
  cap: "64 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "refuse",
  schema: z.string(),
});

const wishChoicesStore = defineStore<WishFieldChoices>({
  owner: "wish.field.choices",
  label: "Wish field choices",
  area: "local",
  cap: "16 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "refuse",
  schema: z.object({
    options: z.record(z.string(), z.unknown()),
    includeUrl: z.boolean().optional(),
  }),
});

const freshChoices = (): WishFieldChoices => ({ options: {} });

/** What the field says about the last submit. */
type Outcome =
  | { kind: "idle" }
  | { kind: "filed"; summary: string }
  | { kind: "failed"; message: string };

function firstLine(text: string): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/**
 * The Wish field a companion shows: the standard task composer (its tool row,
 * the launch-option pills and its own ↑) filing ONE task under Wishes, as the
 * toolbar's Wish button does — with no footer, no chain, and the outcome said
 * inline rather than as a toast (a companion shows none).
 *
 * The draft outlives the panel closing or reloading: the text and the choices
 * are drafts of their own, apart from the toolbar popover's (a companion is a
 * different place to be writing in).
 *
 * The page it is about is the `DraftPage` around it: its URL is what the Page
 * URL toggle attaches, and with none (the tray) there is no toggle and no URL.
 *
 * `filedFrom` is the plugin id of the surface it sits in, recorded as the
 * task's "Filed from".
 */
export function WishField({ filedFrom }: { filedFrom: PluginId }) {
  const [text, setText] = useDraft(wishTextStore, "");
  const [choices, setChoices, clearChoices] = useDraft(
    wishChoicesStore,
    freshChoices,
  );
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const fetchEndpoint = useFetchEndpoint();
  const launchOptions = TaskLaunch.Option.useContributions();
  const captureUrlDefault = useCaptureUrlDefault();
  const page = useDraftPage();

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const result = await submitChain(fetchEndpoint, {
        cards: [
          {
            localId: "wish-field",
            text: trimmed,
            options: choices.options,
            includeUrl: choices.includeUrl,
            linkedToPrev: false,
          },
        ],
        target: { kind: "category", categoryId: WISHES_CATEGORY_ID },
        filedFrom,
        relate: undefined,
        url: page.readUrl?.() ?? null,
        captureUrlDefault,
        options: launchOptions,
      });
      if (result.ok) {
        setOutcome({ kind: "filed", summary: firstLine(trimmed) });
        setText("");
        clearChoices();
      } else {
        setOutcome({
          kind: "failed",
          message: result.errorMessage ?? "Submit failed",
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Stack gap="2xs" className={insetClass({ x: "xs", b: "xs" })}>
      {/* The ring is the field's focus — the accent's ring token, as the
          companion prototypes draw it around the whole box. */}
      <div className="rounded-card focus-within:ring-2 focus-within:ring-ring">
        <TaskDraftComposer
          cardId="wish-field"
          text={text}
          launchOptions={choices.options}
          autoFocus
          disabled={submitting}
          onTextChange={(next) => {
            setText(next);
            if (outcome.kind !== "idle") setOutcome({ kind: "idle" });
          }}
          onLaunchOptionsChange={(options) =>
            setChoices((prev) => ({ ...prev, options }))
          }
          onSubmitChord={() => void submit()}
          isHead
          placeholder="Fix, change or build anything…"
          includeUrl={choices.includeUrl ?? captureUrlDefault}
          onToggleUrl={(includeUrl) =>
            setChoices((prev) => ({ ...prev, includeUrl }))
          }
          submit={{ pending: submitting }}
          relate={null}
        />
      </div>
      {outcome.kind === "filed" && (
        <Stack
          direction="row"
          gap="xs"
          align="center"
          className={cn("text-success", insetClass({ x: "sm" }))}
        >
          <Icon icon={filedIcon} className="size-4" />
          <Text variant="caption">
            Filed — an agent is on “{outcome.summary}”
          </Text>
        </Stack>
      )}
      {outcome.kind === "failed" && (
        <Text
          as="div"
          variant="caption"
          tone="destructive"
          className={insetClass({ x: "sm" })}
        >
          {outcome.message}
        </Text>
      )}
    </Stack>
  );
}
