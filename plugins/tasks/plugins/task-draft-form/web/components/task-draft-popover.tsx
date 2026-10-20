import { useLive } from "@plugins/network/plugins/live/web";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "@plugins/shell/plugins/notifications/web";
import { ResourceView } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  DEFAULT_DRAFT_TTL,
  legacyDraftKeys,
  useDraft,
} from "@plugins/primitives/plugins/persistent-draft/web";
import { defineStore } from "@plugins/primitives/plugins/dom/plugins/web-storage/web";
import { z } from "zod";
import {
  taskRows,
  type TaskListItem,
} from "@plugins/tasks/plugins/tasks-core/core";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { TaskDraftForm, makeCard, type CardDraft } from "./task-draft-form";
import { describeOutcome, submitChain } from "../internal/submit";
import {
  TaskChainRelateModeSchema,
  type TaskChainRelateMode,
  type TaskChainTarget,
} from "@plugins/tasks/core";
import { TaskLaunch } from "@plugins/tasks/plugins/launch-options/web";
import { useActiveRelateContext } from "../active-relate-context";
import { useCaptureUrlDefault } from "../use-capture-url-default";
import { appendSnippet, type TaskDraftInsert } from "../insert-request";

/**
 * Everything the user AUTHORS in the popover, persisted as ONE draft record so
 * closing the popover or reloading the page keeps all of it. Adding a control
 * to the form means adding its field here — there is no second place to keep
 * it, and `resetForm` clears the whole record, so it cannot forget one either.
 *
 * Only user choices are stored, never a default copied in: a missing value
 * means "the default", resolved when read (a card's `includeUrl` / `options`,
 * `insertBefore` below). A copied default goes stale — it stays frozen in the
 * draft after the context that produced it changed.
 *
 * What is NOT here is transient by nature: the submitting flag, the card to
 * auto-focus, the URL snapshotted on open.
 */
interface TaskDraftState {
  cards: CardDraft[];
  /** The explicit `relate` prop's mode. */
  relateMode?: TaskChainRelateMode | undefined;
  /** The mode against the ambient related task (no explicit `relate`). */
  ambientRelateMode?: TaskChainRelateMode | undefined;
  /** A prerequisite that does not take over the related task's dependencies. */
  standalone: boolean;
  /**
   * Which of the related task's children a follow-up goes before. Undefined =
   * all of them. Keyed by the related task, so a choice made against one task
   * never applies to another (the ambient related task follows navigation).
   */
  insertBefore?: { taskId: string; ids: string[] } | undefined;
}

// `:v3` — the popover's separate `cards:v2` / `relate-mode` /
// `ambient-relate-mode` drafts became this one record, so the id was renamed
// and the old entries expire on their TTL (the precedent for a draft shape
// change).
const taskDraftStore = defineStore<TaskDraftState>({
  owner: "task-draft-form.draft",
  label: "Task drafts",
  area: "local",
  cap: "256 KB",
  ttl: DEFAULT_DRAFT_TTL,
  whenFull: "refuse",
  schema: z.object({
    cards: z.array(
      z.object({
        localId: z.string(),
        text: z.string(),
        options: z.record(z.string(), z.unknown()),
        includeUrl: z.boolean().optional(),
        linkedToPrev: z.boolean(),
      }),
    ),
    relateMode: TaskChainRelateModeSchema.optional(),
    ambientRelateMode: TaskChainRelateModeSchema.optional(),
    standalone: z.boolean(),
    insertBefore: z
      .object({ taskId: z.string(), ids: z.array(z.string()) })
      .optional(),
  }),
  legacy: legacyDraftKeys("task-draft:v3"),
});

type PatchDraft = (patch: Partial<TaskDraftState>) => void;

function freshDraft(relate: TaskDraftRelate | undefined): TaskDraftState {
  return {
    cards: [makeCard()],
    relateMode: relate?.defaultMode,
    ambientRelateMode: undefined,
    standalone: false,
    insertBefore: undefined,
  };
}

function draftScope(target: TaskChainTarget): string {
  switch (target.kind) {
    case "category":
      return `category:${target.categoryId}`;
    case "folder":
      return `folder:${target.folderTaskId}`;
    case "root":
      return "root";
  }
}

export interface TaskDraftRelate {
  taskId: string;
  defaultMode: TaskChainRelateMode;
}

export interface TaskDraftPopoverProps {
  trigger: ReactElement;
  tooltip?: ReactNode;
  target: TaskChainTarget;
  relate?: TaskDraftRelate;
  /**
   * One-shot request to insert markdown into the head card, minted by
   * `draftInsert()`. Applied once per request id and *added* to whatever the user
   * has already drafted — never a replacement. Images inline as attachment refs.
   */
  insert?: TaskDraftInsert;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  heading?: string;
  /** The head card's placeholder — what this surface asks the user for. */
  placeholder?: string;
  onSuccess?: (taskIds: string[]) => void;
}

// Inner component that receives settled tasks — all tasks-dependent derivations
// run here so the form never computes from a fake-empty snapshot while loading.
function TaskDraftFormContent({
  tasks,
  draft,
  patchDraft,
  setCards,
  autoFocusId,
  setAutoFocusId,
  submitting,
  setSubmitting,
  url,
  setOpen,
  closeAfterSubmit,
  resetForm,
  relate,
  hasAmbientRelate,
  activeRelate,
  target,
  heading,
  placeholder,
  onSuccess,
  headInsertRef,
}: {
  tasks: readonly TaskListItem[];
  draft: TaskDraftState;
  patchDraft: PatchDraft;
  setCards: (next: CardDraft[]) => void;
  autoFocusId: string | null;
  setAutoFocusId: (id: string | null) => void;
  submitting: boolean;
  setSubmitting: (v: boolean) => void;
  url: string;
  setOpen: (next: boolean) => void;
  closeAfterSubmit: () => void;
  resetForm: () => void;
  relate: TaskDraftRelate | undefined;
  hasAmbientRelate: boolean;
  activeRelate: { taskId: string } | null;
  target: TaskChainTarget;
  heading: string | undefined;
  placeholder: string | undefined;
  onSuccess: ((taskIds: string[]) => void) | undefined;
  headInsertRef: React.MutableRefObject<((snippet: string) => void) | null>;
}) {
  const { cards, standalone } = draft;
  const effectiveRelateTaskId =
    relate?.taskId ?? (hasAmbientRelate ? activeRelate?.taskId : null) ?? null;
  const effectiveRelateMode = relate
    ? draft.relateMode
    : hasAmbientRelate
      ? draft.ambientRelateMode
      : undefined;
  const onRelateModeChange = relate
    ? (v: TaskChainRelateMode | undefined) => patchDraft({ relateMode: v })
    : hasAmbientRelate
      ? (v: TaskChainRelateMode | undefined) =>
          patchDraft({ ambientRelateMode: v })
      : undefined;

  const relateTaskChildren = useMemo(
    () =>
      effectiveRelateTaskId && effectiveRelateMode === "followup"
        ? tasks
            .filter((t) => t.dependencies.includes(effectiveRelateTaskId))
            .map((t) => ({ id: t.id, title: t.title }))
        : [],
    [tasks, effectiveRelateTaskId, effectiveRelateMode],
  );

  const relateTaskHasDeps = useMemo(() => {
    if (!effectiveRelateTaskId || effectiveRelateMode !== "prerequisite")
      return false;
    const t = tasks.find((t) => t.id === effectiveRelateTaskId);
    return t ? t.dependencies.length > 0 : false;
  }, [tasks, effectiveRelateTaskId, effectiveRelateMode]);

  // The stored choice applies only to the task it was made against, and only
  // to children that still exist; otherwise it is the all-children default.
  const insertBeforeIds = useMemo(() => {
    const chosen =
      draft.insertBefore?.taskId === effectiveRelateTaskId
        ? new Set(draft.insertBefore.ids)
        : null;
    return new Set(
      relateTaskChildren
        .map((c) => c.id)
        .filter((id) => chosen === null || chosen.has(id)),
    );
  }, [draft.insertBefore, effectiveRelateTaskId, relateTaskChildren]);
  const setInsertBeforeIds = (next: Set<string>) => {
    if (!effectiveRelateTaskId) return;
    patchDraft({
      insertBefore: { taskId: effectiveRelateTaskId, ids: [...next] },
    });
  };

  const captureUrlDefault = useCaptureUrlDefault();
  // The live launch-option registry: reading it is a hook, so it happens here
  // and `submitChain` / `describeOutcome` stay pure over an explicit list.
  const launchOptions = TaskLaunch.Option.useContributions();

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const insertBefore =
        relateTaskChildren.length > 0 ? Array.from(insertBeforeIds) : undefined;

      const effectiveRelate =
        effectiveRelateTaskId && effectiveRelateMode
          ? {
              taskId: effectiveRelateTaskId,
              mode: effectiveRelateMode,
              insertBefore:
                effectiveRelateMode === "followup" ? insertBefore : undefined,
              standalone:
                effectiveRelateMode === "prerequisite" && standalone
                  ? true
                  : undefined,
            }
          : undefined;

      const effectiveTarget: TaskChainTarget =
        hasAmbientRelate && draft.ambientRelateMode
          ? { kind: "folder", folderTaskId: activeRelate!.taskId }
          : target;

      const outcome = await submitChain({
        cards,
        target: effectiveTarget,
        relate: effectiveRelate,
        url,
        captureUrlDefault,
        options: launchOptions,
      });
      if (!outcome.ok) {
        toast({
          type: "task",
          title: "Task submit failed",
          description: outcome.errorMessage ?? "Submit failed",
          variant: "error",
        });
        return;
      }
      toast({
        type: "task",
        ...describeOutcome(outcome, cards, launchOptions),
        variant: "success",
      });
      onSuccess?.(outcome.taskIds ?? []);
      resetForm();
      closeAfterSubmit();
    } catch (err) {
      toast({
        type: "task",
        title: "Task submit failed",
        description: (err as Error).message,
        variant: "error",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <TaskDraftForm
      cards={cards}
      onCardsChange={setCards}
      autoFocusId={autoFocusId}
      onAutoFocusHandled={() => setAutoFocusId(null)}
      submitting={submitting}
      onSubmit={submit}
      onCancel={() => setOpen(false)}
      relateMode={effectiveRelateMode}
      onRelateModeChange={onRelateModeChange}
      showIndependentRelate={hasAmbientRelate}
      relateTaskChildren={relateTaskChildren}
      insertBeforeIds={insertBeforeIds}
      onInsertBeforeChange={setInsertBeforeIds}
      standalone={standalone}
      onStandaloneChange={(v) => patchDraft({ standalone: v })}
      showStandalone={relateTaskHasDeps}
      heading={heading}
      placeholder={placeholder}
      headInsertRef={headInsertRef}
    />
  );
}

export function TaskDraftPopover({
  trigger,
  tooltip,
  target,
  relate,
  insert,
  open: controlledOpen,
  onOpenChange,
  heading,
  placeholder,
  onSuccess,
}: TaskDraftPopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const [draft, setDraft, clearDraft] = useDraft(
    taskDraftStore,
    () => freshDraft(relate),
    { scope: draftScope(target) },
  );
  const patchDraft = useCallback<PatchDraft>(
    (patch) => setDraft((prev) => ({ ...prev, ...patch })),
    [setDraft],
  );
  const { cards } = draft;
  const setCards = useCallback(
    (next: CardDraft[]) => patchDraft({ cards: next }),
    [patchDraft],
  );

  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const activeRelate = useActiveRelateContext();
  const hasAmbientRelate = !relate && activeRelate !== null;

  const tasksResult = useLive(taskRows);

  const seenIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const seen = seenIdsRef.current;
    let newest: string | null = null;
    for (const c of cards) {
      if (!seen.has(c.localId)) newest = c.localId;
    }
    seenIdsRef.current = new Set(cards.map((c) => c.localId));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- new-card detector: diffs the live cards against the previous render's seenIdsRef to find the just-added card and auto-focus it; depends on historical (prior-render) identity, so it cannot be derived in render or replaced by a primitive
    if (newest) setAutoFocusId(newest);
  }, [cards]);

  // The single funnel every programmatic insert goes through — the external
  // request below and the in-form `TaskDraftFormSlots.Action` buttons alike, so
  // "attach this to my draft" cannot mean two different things depending on
  // whether the popover happened to be open already.
  //
  // Caret insert when the head editor is mounted (the snippet deserializes into
  // its chip on the way in and the user keeps typing after it); append to the
  // head card's markdown when it is not — popover still closed, or the form is
  // behind its tasks-loading fallback. Both paths ADD to the draft.
  const headInsertRef = useRef<((snippet: string) => void) | null>(null);
  const applyInsert = useCallback(
    (snippet: string) => {
      const insertAtCaret = headInsertRef.current;
      if (insertAtCaret) {
        insertAtCaret(snippet);
        return;
      }
      setDraft((prev) => ({
        ...prev,
        cards: [
          {
            ...prev.cards[0]!,
            text: appendSnippet(prev.cards[0]!.text, snippet),
          },
          ...prev.cards.slice(1),
        ],
      }));
      seenIdsRef.current = new Set();
    },
    [setDraft],
  );

  // Apply each insertion request once. Keyed on the request id (not the text) so
  // requesting the same snippet twice inserts twice, and so a remount — closing
  // and reopening the popover — never re-applies one already taken. The ref
  // outlives the popover's content because this component is always mounted.
  const appliedInsertIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!insert || appliedInsertIdRef.current === insert.id) return;
    appliedInsertIdRef.current = insert.id;
    applyInsert(insert.text);
  }, [insert, applyInsert]);

  // Where focus goes when the popover closes. A dismissal (Esc, Cancel, a click
  // outside) hands it back to the trigger — the keyboard user keeps their place.
  // A submit does not: the popover finished its job, and a trigger refocused
  // right after a keyboard shortcut (mod+Enter) matches :focus-visible, so the
  // button would light up with a focus ring for no reason. Read by base-ui at
  // the moment the popup unmounts, so the flag set just before closing wins.
  const returnFocusOnCloseRef = useRef(true);
  const closeAfterSubmit = () => {
    returnFocusOnCloseRef.current = false;
    setOpen(false);
  };

  // On the open transition, snapshot the current URL (what the "Page URL" toggle
  // attaches), focus the last card, and re-arm focus return for this session.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      returnFocusOnCloseRef.current = true;
      setUrl(window.location.href);
      setAutoFocusId(cards.at(-1)?.localId ?? null);
    }
    wasOpenRef.current = open;
  }, [open, cards]);

  const setOpen = (next: boolean) => {
    if (isControlled) {
      onOpenChange?.(next);
    } else {
      setUncontrolledOpen(next);
      onOpenChange?.(next);
    }
  };

  const resetForm = () => {
    clearDraft();
    seenIdsRef.current = new Set();
  };

  return (
    <InlinePopover
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      tooltip={tooltip}
      finalFocus={() => returnFocusOnCloseRef.current}
    >
      <ResourceView
        resource={tasksResult}
        fallback={<Loading variant="rows" />}
      >
        {(tasks) => (
          <TaskDraftFormContent
            tasks={tasks}
            draft={draft}
            patchDraft={patchDraft}
            setCards={setCards}
            autoFocusId={autoFocusId}
            setAutoFocusId={setAutoFocusId}
            submitting={submitting}
            setSubmitting={setSubmitting}
            url={url}
            setOpen={setOpen}
            closeAfterSubmit={closeAfterSubmit}
            resetForm={resetForm}
            relate={relate}
            hasAmbientRelate={hasAmbientRelate}
            activeRelate={activeRelate}
            target={target}
            heading={heading}
            placeholder={placeholder}
            onSuccess={onSuccess}
            headInsertRef={headInsertRef}
          />
        )}
      </ResourceView>
    </InlinePopover>
  );
}
