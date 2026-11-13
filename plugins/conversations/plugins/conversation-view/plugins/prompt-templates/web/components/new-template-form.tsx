import { useEffect, useRef, useState } from "react";
import {
  Button,
  Input,
  Textarea,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useReportPopupOpen } from "@plugins/primitives/plugins/overlay/plugins/popup-open/web";
import { focusElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";

/** What the inline editor hands back: a template still without its id. */
export interface NewTemplate {
  title: string;
  prompt: string;
}

export interface NewTemplateFormProps {
  /** The prompt it opens with (the current draft, when there is one). */
  initialPrompt: string;
  onAdd: (t: NewTemplate) => void;
  /** Leave the editor without adding (Cancel, Escape, a press outside it). */
  onClose: () => void;
}

/**
 * The template panel's inline "new template" editor: a name and a prompt,
 * added in place — no dialog, no trip to Settings.
 *
 * While it is open it holds the hover panel around it open (it reports itself
 * as an open popup to the panel's `PopupOpenScope`), so the panel does not fold
 * up under a half-typed template when the pointer drifts off. The hold also
 * hands Escape and outside presses to this editor, which is why it handles
 * both itself.
 */
export function NewTemplateForm({
  initialPrompt,
  onAdd,
  onClose,
}: NewTemplateFormProps) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState(initialPrompt);
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

  const canAdd = title.trim() !== "" && prompt.trim() !== "";
  function add() {
    if (!canAdd) return;
    onAdd({ title: title.trim(), prompt: prompt.trim() });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  return (
    <Stack ref={rootRef} gap="xs" onKeyDown={onKeyDown} className="w-72">
      <Input
        autoFocus
        placeholder="Name"
        aria-label="Template name"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          // Enter on the name adds when the prompt is already there (the
          // draft), and otherwise moves on to write it.
          if (canAdd) add();
          else focusElement(promptRef.current, { reveal: true });
        }}
      />
      <Textarea
        ref={promptRef}
        placeholder="Prompt"
        aria-label="Template prompt"
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            add();
          }
        }}
      />
      <Stack direction="row" gap="xs" justify="end">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!canAdd} onClick={add}>
          Add
        </Button>
      </Stack>
    </Stack>
  );
}
