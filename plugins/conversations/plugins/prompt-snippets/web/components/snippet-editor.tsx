import { useEffect, useRef } from "react";
import { z } from "zod";
import { keptField } from "@plugins/primitives/plugins/kept-state/core";
import { hash53 } from "@plugins/packages/plugins/string-hash/core";
import {
  defineKept,
  useKept,
} from "@plugins/primitives/plugins/kept-state/web";
import {
  Button,
  Input,
  Textarea,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useReportPopupOpen } from "@plugins/primitives/plugins/overlay/plugins/popup-open/web";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";

/** A snippet's editable content: what the editor reads and hands back. */
export interface SnippetDraft {
  title: string;
  prompt: string;
}

/**
 * What is typed into an open snippet editor, kept per snippet (a new one's
 * under `new`) AND per what it opened with, so a reload, a tab switch or a
 * stray press outside the popup gives it back when the editor reopens on the
 * same start — while a snippet changed elsewhere since, or a new one
 * prefilled from another draft, opens fresh instead of under stale text.
 * Cleared once a save or a delete is taken, and on Cancel / Escape (an
 * explicit discard).
 */
const snippetDraft = defineKept({
  owner: "prompt-snippets.editor",
  label: "Snippet drafts",
  tier: "work",
  cap: "64 KB",
  schema: z.object({ title: z.string(), prompt: z.string() }),
});

export interface SnippetEditorProps {
  /** What it opens with: the snippet being edited, or a new one's start. */
  initial: SnippetDraft;
  /** `new` adds (its button reads Add); `edit` saves and can delete. */
  mode: "new" | "edit";
  /**
   * What the typed draft belongs to within its list (`new`, or the edited
   * snippet's id) — with `noun`, the key it is kept under.
   */
  subject: string;
  /** What a snippet is called here ("Template", "Preprompt"): the fields' accessible names. */
  noun: string;
  /** Store it; answers whether it was taken (refused: the editor stays open with what was typed). */
  onSave: (d: SnippetDraft) => boolean;
  /** Edit only: remove the snippet; answers whether it was taken. */
  onDelete?: () => boolean;
  /** Leave without saving (Cancel, Escape, a press outside it). */
  onClose: () => void;
}

/**
 * The inline editor of a named prompt snippet (a prompt template, a
 * preprompt): a name and a prompt, edited in place inside whatever popup lists
 * them — no dialog, no trip to Settings.
 *
 * While it is open it holds the popup around it open (it reports itself as an
 * open popup to the nearest `PopupOpenScope`), so a hover panel does not fold
 * up under a half-typed snippet when the pointer drifts off. The hold also
 * hands Escape and outside presses to this editor, which is why it handles
 * both itself.
 *
 * Every key typed into it stays in it: a menu host (the preprompt pill) reads
 * keys for its own navigation and typeahead, which would otherwise take the
 * letters of a name as jumps between rows.
 */
export function SnippetEditor({
  initial,
  mode,
  subject,
  noun,
  onSave,
  onDelete,
  onClose,
}: SnippetEditorProps) {
  const draft = useKept(snippetDraft, initial, {
    subject: `${noun}|${subject}|${hash53(JSON.stringify(initial))}`,
  });
  const [{ title, prompt }, , discard] = draft;
  const rootRef = useRef<HTMLElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useReportPopupOpen(true);

  // A press anywhere outside the editor leaves it — a hover panel's own
  // outside press is suspended while the editor holds it open.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) {
        // Kept: a stray press must not lose a long prompt — it comes back
        // when the editor reopens.
        onClose();
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  const canSave = title.trim() !== "" && prompt.trim() !== "";
  function save() {
    if (!canSave) return;
    if (onSave({ title: title.trim(), prompt: prompt.trim() })) discard();
  }
  function cancel() {
    discard();
    onClose();
  }

  return (
    <Stack
      ref={rootRef}
      gap="xs"
      className="py-xs"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
    >
      <Input
        autoFocus
        placeholder="Name"
        aria-label={`${noun} name`}
        keep={keptField(draft, "title")}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          // Enter on the name saves when the prompt is already there (a
          // prefilled draft, or the snippet being edited), and otherwise
          // moves on.
          if (canSave) save();
          else focusElement(promptRef.current, { reveal: true });
        }}
      />
      <Textarea
        ref={promptRef}
        fitContent
        placeholder="Prompt"
        aria-label={`${noun} prompt`}
        keep={keptField(draft, "prompt")}
        className="min-h-18 max-h-40"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
        }}
      />
      {/* Delete at the start, the commit pair at the end: the destructive
          action sits apart from the one Enter takes. */}
      <Stack direction="row" gap="xs" align="center" justify="between">
        {onDelete ? (
          <Button
            variant="ghost"
            className="text-destructive"
            onClick={() => {
              if (onDelete()) discard();
            }}
          >
            Delete
          </Button>
        ) : (
          <span />
        )}
        <Stack direction="row" gap="xs" align="center">
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={save}>
            {mode === "new" ? "Add" : "Save"}
          </Button>
        </Stack>
      </Stack>
    </Stack>
  );
}
