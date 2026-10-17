import { useRef } from "react";
import {
  ComposerField,
  ComposerAttachButton,
  ComposerRule,
} from "@plugins/primitives/plugins/text-editor/plugins/composer/web";
import {
  LaunchOptionPills,
  type LaunchOptionValues,
} from "@plugins/tasks/plugins/launch-options/web";
import { DependencyPill, type DependencyExtras } from "./dependency-pill";
import { TaskDraftFormSlots } from "../slots";
import type { TaskChainRelateMode } from "@plugins/tasks/core";
import { symbol } from "@plugins/ui/plugins/icons/core";

const linkIcon = symbol("link");

export interface TaskDraftComposerProps {
  /** Scopes the editor's namespace; unique per mounted composer. */
  cardId: string;
  text: string;
  /** Contributed launch-option values, keyed by option id. */
  launchOptions: LaunchOptionValues;
  autoFocus: boolean;
  disabled: boolean;
  onTextChange: (next: string) => void;
  onLaunchOptionsChange: (next: LaunchOptionValues) => void;
  onSubmitChord: () => void;
  isHead: boolean;
  /** Overrides the head card's placeholder ("Describe the task…"). */
  placeholder?: string | undefined;
  /**
   * Optional host-owned home for this composer's insert-at-caret handle. Omitted,
   * the composer keeps the handle to itself.
   */
  insertRef?:
    React.MutableRefObject<((snippet: string) => void) | null> | undefined;
  // Whether the drafted task attaches the current page URL.
  includeUrl: boolean;
  onToggleUrl: (v: boolean) => void;
  /** The head card's relate toggle, or null for none. */
  relate: {
    value: TaskChainRelateMode | undefined;
    onChange: (next: TaskChainRelateMode | undefined) => void;
    showIndependent?: boolean | undefined;
    extras?: DependencyExtras | undefined;
  } | null;
}

/**
 * One task's composer: the prose field and its bar — the context it carries
 * (the contributed prose actions such as the element picker, and the page-URL
 * toggle) and the launch-option pills. Everything about the TASK, nothing about the chain card that holds it
 * (drag, remove): so it renders on its own, which is what the composer
 * exhibit does.
 */
export function TaskDraftComposer({
  cardId,
  text,
  launchOptions,
  autoFocus,
  disabled,
  onTextChange,
  onLaunchOptionsChange,
  onSubmitChord,
  isHead,
  placeholder,
  insertRef: hostInsertRef,
  includeUrl,
  onToggleUrl,
  relate,
}: TaskDraftComposerProps) {
  // Drives the action slot (e.g. the element picker): the snippet lands at the
  // caret, deserialized into its chip by the editor's node extensions. Falls
  // back to the end of the document when the editor was never focused (no live
  // selection). The host may own the handle instead, so its own programmatic
  // inserts go through this exact path.
  const localInsertRef = useRef<((snippet: string) => void) | null>(null);
  const insertRef = hostInsertRef ?? localInsertRef;
  const insertText = (snippet: string) => {
    const insert = insertRef.current;
    if (!insert) throw new Error("TaskDraftComposer: editor not mounted");
    insert(snippet);
  };

  return (
    <ComposerField
      value={text}
      onChange={onTextChange}
      onSubmit={onSubmitChord}
      submitMode="cmd-enter"
      placeholder={
        isHead ? (placeholder ?? "Describe the task…") : "Next task…"
      }
      disabled={disabled}
      autoFocus={autoFocus}
      minRows={isHead ? 3 : 2}
      maxHeight={isHead ? "20rem" : "8rem"}
      namespace={`task-draft-card-${cardId}`}
      insertRef={insertRef}
      barStart={
        <CardBarStart
          insertText={insertText}
          includeUrl={includeUrl}
          onToggleUrl={onToggleUrl}
          values={launchOptions}
          onChange={onLaunchOptionsChange}
          disabled={disabled}
          relate={relate}
        />
      }
      barEnd={
        <LaunchOptionPills
          side="end"
          values={launchOptions}
          onChange={onLaunchOptionsChange}
          disabled={disabled}
        />
      }
    />
  );
}

/**
 * The leading half of the card's bar: what the agent will see — the
 * contributed actions that write into the prose (the element picker) and the
 * page-URL toggle — then, past a hairline, the pills that configure what
 * submitting it does.
 *
 * Every card carries the action slot, not just the head: each card owns its own
 * caret-insert handle, so a picked element lands in the prose you are actually
 * writing. (The HOST's funnel is the head card's alone — that is where an
 * insert fired from outside the form has to go, since it must pick one card.)
 */
function CardBarStart({
  insertText,
  includeUrl,
  onToggleUrl,
  values,
  onChange,
  disabled,
  relate,
}: {
  insertText: (text: string) => void;
  includeUrl: boolean;
  onToggleUrl: (v: boolean) => void;
  values: LaunchOptionValues;
  onChange: (next: LaunchOptionValues) => void;
  disabled: boolean;
  relate: TaskDraftComposerProps["relate"];
}) {
  return (
    <>
      <TaskDraftFormSlots.Action.Render>
        {(item) => <item.component insertText={insertText} />}
      </TaskDraftFormSlots.Action.Render>
      <ComposerAttachButton
        icon={linkIcon}
        label="Page URL"
        description="Record the page you are on with the task, so the agent knows which screen it is about."
        active={includeUrl}
        onToggle={onToggleUrl}
        disabled={disabled}
      />
      <ComposerRule />
      {/* A bare icon while on its default: the card's bar is narrow, and an
          unset setting should take no room. */}
      <LaunchOptionPills
        side="start"
        values={values}
        onChange={onChange}
        disabled={disabled}
        unset="icon"
      />
      {relate && (
        <DependencyPill
          value={relate.value}
          onChange={relate.onChange}
          showIndependent={relate.showIndependent}
          extras={relate.extras}
          disabled={disabled}
        />
      )}
    </>
  );
}
