import { useEffect, useRef, useState } from "react";
import {
  Button,
  Input,
  Textarea,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useReportPopupOpen } from "@plugins/primitives/plugins/overlay/plugins/popup-open/web";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";

/** A template's editable content: what the editor reads and hands back. */
export interface TemplateDraft {
  title: string;
  prompt: string;
}

export interface TemplateEditorProps {
  /** What it opens with: the template being edited, or a new one's start. */
  initial: TemplateDraft;
  /** `new` adds (its button reads Add); `edit` saves and can delete. */
  mode: "new" | "edit";
  onSave: (t: TemplateDraft) => void;
  /** Edit only: remove the template. */
  onDelete?: () => void;
  /** Leave without saving (Cancel, Escape, a press outside it). */
  onClose: () => void;
}

/**
 * The template panel's inline editor: a name and a prompt, edited in place —
 * no dialog, no trip to Settings.
 *
 * While it is open it holds the hover panel around it open (it reports itself
 * as an open popup to the panel's `PopupOpenScope`), so the panel does not fold
 * up under a half-typed template when the pointer drifts off. The hold also
 * hands Escape and outside presses to this editor, which is why it handles
 * both itself.
 */
export function TemplateEditor({
  initial,
  mode,
  onSave,
  onDelete,
  onClose,
}: TemplateEditorProps) {
  const [title, setTitle] = useState(initial.title);
  const [prompt, setPrompt] = useState(initial.prompt);
  const rootRef = useRef<HTMLElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useReportPopupOpen(true);

  // A press anywhere outside the editor leaves it — the panel's own outside
  // press is suspended while the editor holds it open.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const root = rootRef.current;
      if (root && e.target instanceof Node && !root.contains(e.target)) {
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
    onSave({ title: title.trim(), prompt: prompt.trim() });
  }

  return (
    <Stack
      ref={rootRef}
      gap="xs"
      className="py-xs"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <Input
        autoFocus
        placeholder="Name"
        aria-label="Template name"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          // Enter on the name saves when the prompt is already there (the
          // draft, or the template being edited), and otherwise moves on.
          if (canSave) save();
          else focusElement(promptRef.current, { reveal: true });
        }}
      />
      <Textarea
        ref={promptRef}
        fitContent
        placeholder="Prompt"
        aria-label="Template prompt"
        className="min-h-18 max-h-40"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
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
            onClick={onDelete}
          >
            Delete
          </Button>
        ) : (
          <span />
        )}
        <Stack direction="row" gap="xs" align="center">
          <Button variant="ghost" onClick={onClose}>
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
