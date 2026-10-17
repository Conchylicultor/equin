import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  SortableList,
  arrayMove,
} from "@plugins/primitives/plugins/sortable-list/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import {
  Kbd,
  TooltipDoc,
} from "@plugins/primitives/plugins/overlay/plugins/tooltip/web";
import { TaskDraftCard } from "./task-draft-card";
import { ChainConnector } from "./chain-connector";
import type { ChildEntry, DependencyExtras } from "./dependency-pill";
import type { TaskChainRelateMode } from "@plugins/tasks/core";
import type { LaunchOptionValues } from "@plugins/tasks/plugins/launch-options/web";
import {
  MAIN_COMPOSITION_ID,
  namespaceFromHost,
} from "@plugins/infra/plugins/namespace/core";
import { useCaptureUrlDefault } from "../use-capture-url-default";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { TASK_DRAFT_FORM_WIDTH } from "../../core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const addIcon = symbol("add");
const closeIcon = symbol("close");
const scienceIcon = symbol("science");

export interface CardDraft {
  localId: string;
  text: string;
  // Contributed launch-option values keyed by option id (see
  // `@plugins/tasks/plugins/launch-options`). Open by construction, so a new
  // option needs no field here. Holds only the values the user SET: a missing
  // id is the option's default, resolved on read (`launchOptionValue`), so a
  // saved draft never freezes a default that has since changed.
  options: LaunchOptionValues;
  // Whether to attach the page URL, when the user chose; `undefined` follows
  // the app the form is open in (`useCaptureUrlDefault`), resolved on read.
  // Never stored as the default: the draft is shared across apps, so a copied
  // default from one app would override every other app's.
  includeUrl?: boolean;
  linkedToPrev: boolean;
}

export interface TaskDraftFormProps {
  cards: CardDraft[];
  onCardsChange: (next: CardDraft[]) => void;
  autoFocusId: string | null;
  onAutoFocusHandled: () => void;
  submitting: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  // Head-card relate toggle (only rendered when both are supplied).
  relateMode?: TaskChainRelateMode | undefined;
  onRelateModeChange?: (next: TaskChainRelateMode | undefined) => void;
  showIndependentRelate?: boolean;
  // Insert-before-children (follow-up mode with children).
  relateTaskChildren?: ChildEntry[];
  insertBeforeIds?: Set<string>;
  onInsertBeforeChange?: (next: Set<string>) => void;
  // Standalone prerequisite (don't transfer target's existing deps).
  standalone?: boolean;
  onStandaloneChange?: (next: boolean) => void;
  showStandalone?: boolean;
  heading?: string;
  /** The head card's placeholder; defaults to "Describe the task…". */
  placeholder?: string;
  /**
   * Receives the head card editor's insert-at-caret handle while it is mounted,
   * so the host can route programmatic inserts (see `TaskDraftPopover`'s insert
   * funnel) through the same path the in-form action buttons use.
   */
  headInsertRef?: React.MutableRefObject<((snippet: string) => void) | null>;
}

function useIsAgentWorktree(): boolean {
  return useMemo(() => {
    // No namespace at all (bare `localhost`) is not an agent worktree either.
    const ns = namespaceFromHost(window.location.host);
    return ns !== null && ns !== MAIN_COMPOSITION_ID;
  }, []);
}

/** A blank card; `options` / `includeUrl` carry choices, never defaults. */
export function makeCard(
  options: LaunchOptionValues = {},
  includeUrl?: boolean,
): CardDraft {
  return {
    localId: crypto.randomUUID(),
    text: "",
    options,
    includeUrl,
    linkedToPrev: true,
  };
}

export function TaskDraftForm({
  cards,
  onCardsChange,
  autoFocusId,
  onAutoFocusHandled,
  submitting,
  onSubmit,
  onCancel,
  relateMode,
  onRelateModeChange,
  showIndependentRelate,
  relateTaskChildren,
  insertBeforeIds,
  onInsertBeforeChange,
  standalone,
  onStandaloneChange,
  showStandalone,
  heading,
  placeholder,
  headInsertRef,
}: TaskDraftFormProps) {
  const isAgentWorktree = useIsAgentWorktree();
  const [draggingId, setDraggingId] = useState<string | null>(null);

  useEffect(() => {
    if (autoFocusId) {
      const t = window.setTimeout(onAutoFocusHandled, 0);
      return () => window.clearTimeout(t);
    }
  }, [autoFocusId, onAutoFocusHandled]);

  const isMulti = cards.length > 1;
  const hasEmpty = cards.some((c) => !c.text.trim());
  const disabled = hasEmpty || submitting;
  const captureUrlDefault = useCaptureUrlDefault();

  const updateCard = (idx: number, patch: Partial<CardDraft>) => {
    const next = cards.slice();
    next[idx] = { ...next[idx]!, ...patch };
    onCardsChange(next);
  };

  // A new card inherits the neighbour's choices — its whole launch
  // configuration in one spread, so a future option is carried along without
  // touching this. What the neighbour left at its default stays a default.
  const cardAfter = (inheritFrom: CardDraft | undefined) =>
    makeCard({ ...inheritFrom?.options }, inheritFrom?.includeUrl);

  const insertAt = (idx: number) => {
    if (submitting) return;
    const card = cardAfter(cards[idx] ?? cards[idx - 1]);
    const next = [...cards.slice(0, idx), card, ...cards.slice(idx)];
    onCardsChange(next);
  };

  const appendChainCard = () => {
    if (submitting) return;
    onCardsChange([...cards, cardAfter(cards[cards.length - 1])]);
  };

  const toggleLink = (idx: number) => {
    onCardsChange(
      cards.map((c, i) =>
        i === idx ? { ...c, linkedToPrev: !c.linkedToPrev } : c,
      ),
    );
  };

  const removeAt = (idx: number) => {
    if (submitting || cards.length <= 1) return;
    const next = cards.filter((_, i) => i !== idx);
    onCardsChange(next);
  };

  // The mode's extra choices ride in the head card's Dependency menu: which of
  // the related task's children a follow-up goes before, and whether a
  // prerequisite stands alone. Each only when it has something to say.
  const headExtras: DependencyExtras = {
    insertBefore:
      relateMode === "followup" &&
      relateTaskChildren &&
      relateTaskChildren.length > 0 &&
      insertBeforeIds &&
      onInsertBeforeChange
        ? {
            children: relateTaskChildren,
            selected: insertBeforeIds,
            onChange: onInsertBeforeChange,
          }
        : undefined,
    standalone:
      relateMode === "prerequisite" && showStandalone && onStandaloneChange
        ? { checked: !!standalone, onChange: onStandaloneChange }
        : undefined,
  };

  const onMove = (activeId: string, overId: string) => {
    const from = cards.findIndex((c) => c.localId === activeId);
    const to = cards.findIndex((c) => c.localId === overId);
    if (from < 0 || to < 0) return;
    onCardsChange(arrayMove(cards, from, to));
  };

  return (
    <Stack
      gap="sm"
      // Fixed px: the form is the popover's one column, shared with its exhibit.
      style={{ width: TASK_DRAFT_FORM_WIDTH }}
      className={
        isAgentWorktree ? "rounded-lg border-2 border-destructive/60 p-md" : ""
      }
    >
      {isAgentWorktree && (
        <Stack
          direction="row"
          align="center"
          gap="xs"
          className="text-destructive"
        >
          <Icon icon={scienceIcon} className="size-3.5" />
          <Text as="span" variant="caption" className="font-medium">
            Experimental — tasks target main from an agent worktree
          </Text>
        </Stack>
      )}
      <Line className="gap-sm">
        <Fill>
          <Text as="h2" variant="label" className="font-semibold">
            {heading ?? "Draft tasks"}
          </Text>
        </Fill>
        {/* The first card has no connector to carry its ×, so the header's
            stands in: with a chain it drops task 1 (task 2 becomes the head);
            with one task left there is nothing to drop, so it closes. */}
        {isMulti ? (
          <IconButton
            icon={closeIcon}
            label="Remove task 1"
            onClick={() => removeAt(0)}
            disabled={submitting}
          />
        ) : (
          <IconButton icon={closeIcon} label="Close" onClick={onCancel} />
        )}
      </Line>

      {/* A focused grip moves with Space, then ↑/↓, then Space to drop. */}
      <SortableList
        items={cards.map((c) => c.localId)}
        onMove={onMove}
        keyboard
        onActiveChange={setDraggingId}
      >
        <Stack gap="none">
          {cards.map((card, idx) => {
            const isHead = idx === 0;
            return (
              <Fragment key={card.localId}>
                {idx > 0 && (
                  <ChainConnector
                    linked={card.linkedToPrev}
                    prevNumber={idx}
                    onToggle={() => toggleLink(idx)}
                    onInsert={() => insertAt(idx)}
                    onRemove={() => removeAt(idx)}
                    disabled={submitting || !!draggingId}
                  />
                )}
                <TaskDraftCard
                  isHead={isHead}
                  placeholder={isHead ? placeholder : undefined}
                  insertRef={isHead ? headInsertRef : undefined}
                  cardId={card.localId}
                  index={idx}
                  text={card.text}
                  launchOptions={card.options}
                  autoFocus={autoFocusId === card.localId}
                  movable={isMulti}
                  disabled={submitting}
                  onTextChange={(t) => updateCard(idx, { text: t })}
                  onLaunchOptionsChange={(o) => updateCard(idx, { options: o })}
                  onSubmitChord={() => {
                    if (!disabled) onSubmit();
                  }}
                  includeUrl={card.includeUrl ?? captureUrlDefault}
                  onToggleUrl={(v) => updateCard(idx, { includeUrl: v })}
                  relateMode={isHead ? relateMode : undefined}
                  onRelateModeChange={isHead ? onRelateModeChange : undefined}
                  showIndependentRelate={
                    isHead ? showIndependentRelate : undefined
                  }
                  relateExtras={isHead ? headExtras : undefined}
                />
              </Fragment>
            );
          })}
        </Stack>
      </SortableList>

      <Line className="gap-sm">
        <Button
          tooltip={
            <TooltipDoc title="Follow-up task">
              Draft another task below this one, created together with it. It
              runs after the task above it; unlink them to run in parallel.
            </TooltipDoc>
          }
          variant="ghost"
            onClick={appendChainCard}
            loading={submitting}
            className="text-muted-foreground"
          >
            <Icon icon={addIcon} className="size-3.5" />
            Follow-up task
        </Button>
        {/* Empty grow cell: it absorbs the slack so Cancel/Create sit flush-right. */}
        <Fill />
        <Button variant="ghost" onClick={onCancel} loading={submitting}>
          Cancel
        </Button>
        <Button onClick={onSubmit} loading={submitting} disabled={hasEmpty}>
          {isMulti ? `Create ${cards.length} tasks` : "Create task"}
          <Kbd className="border-transparent bg-primary-foreground/15 text-primary-foreground">
            ⌘↵
          </Kbd>
        </Button>
      </Line>
    </Stack>
  );
}
