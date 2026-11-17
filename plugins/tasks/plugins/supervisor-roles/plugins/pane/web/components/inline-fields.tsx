import { useRef, useState, type ReactElement } from "react";
import {
  useEditableField,
  type UseEditableFieldOptions,
} from "@plugins/primitives/plugins/editable-field/web";
import { TextEditor } from "@plugins/primitives/plugins/text-editor/web";
import { Markdown } from "@plugins/primitives/plugins/markdown/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  cn,
  Textarea,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

// The Supervisors pane edits every setting in place — no dialog, no Save.
// Both fields autosave through `useEditableField` (debounced, flushed on
// blur), and its `keep` (the caller's: which field of which record) keeps
// text not saved yet across a reload or a tab switch.
type FieldKeep = UseEditableFieldOptions<string>["keep"];

/**
 * A plain-text value edited in place: a field that reads as text at rest and
 * wraps a long value.
 * `variant="title"` for a heading (the role's name). `multiline` keeps the
 * line breaks typed (Enter adds one, Escape ends the edit); otherwise the
 * value is one line and Enter ends the edit.
 */
export function InlineTextField({
  value,
  onSave,
  keep,
  label,
  placeholder,
  disabled,
  variant = "body",
  autoFocus,
  multiline,
}: {
  value: string;
  onSave: (next: string) => void | Promise<void>;
  keep: FieldKeep;
  label: string;
  placeholder: string;
  disabled?: boolean;
  variant?: "body" | "title";
  autoFocus?: boolean;
  multiline?: boolean;
}): ReactElement {
  const field = useEditableField({ value, onSave, label, keep });
  // A textarea sized by its content (`field-sizing: content`), so a long
  // value wraps instead of scrolling out of sight.
  return (
    <Textarea
      bare
      keep={field.keep}
      aria-label={label}
      rows={1}
      disabled={disabled}
      autoFocus={autoFocus}
      onChange={(e) => {
        // One line: a pasted line break becomes a space.
        if (!multiline && e.target.value.includes("\n"))
          field.onChange(e.target.value.replace(/\n/g, " "));
      }}
      onFocus={field.onFocus}
      onBlur={field.onBlur}
      onKeyDown={(e) => {
        if (e.key === "Escape" || (e.key === "Enter" && !multiline)) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      placeholder={placeholder}
      className={cn(
        "field-sizing-content w-full resize-none rounded-md bg-transparent outline-none placeholder:text-muted-foreground focus:ring-0",
        variant === "title" ? "text-title" : "text-body",
        disabled && "cursor-default",
      )}
    />
  );
}

/**
 * A markdown text edited in place: rendered at rest, the rich editor while
 * focused. Click anywhere on it to edit; leaving it returns to the rendering.
 */
export function InlineMarkdownField({
  value,
  onSave,
  keep,
  label,
  placeholder,
  namespace,
  startEditing,
}: {
  value: string;
  onSave: (next: string) => void | Promise<void>;
  keep: FieldKeep;
  label: string;
  placeholder: string;
  /** The editor's Lexical namespace (one per kind of field). */
  namespace: string;
  /** Open in the editor (a role just created, its prompt still to write). */
  startEditing?: boolean;
}): ReactElement {
  const field = useEditableField({ value, onSave, label, keep });
  const [editing, setEditing] = useState(startEditing ?? false);
  // Focus can leave the editor's DOM for a popup it portals (and come back in
  // the same task): only a leave that stays gone ends the edit.
  const leaving = useRef(false);

  if (editing) {
    return (
      <div
        onFocus={() => {
          leaving.current = false;
          field.onFocus();
        }}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          leaving.current = true;
          queueMicrotask(() => {
            if (!leaving.current) return;
            leaving.current = false;
            setEditing(false);
            field.onBlur();
          });
        }}
      >
        <TextEditor
          keep={field.keep}
          placeholder={placeholder}
          autoFocus
          minRows={4}
          namespace={namespace}
        />
      </div>
    );
  }
  return (
    <Text
      as="div"
      variant="body"
      role="button"
      tabIndex={0}
      aria-label={`Edit ${label.toLowerCase()}`}
      className="w-full cursor-text rounded-md"
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") setEditing(true);
      }}
    >
      {field.value.trim() === "" ? (
        <Text as="span" tone="muted">
          {placeholder}
        </Text>
      ) : (
        <Markdown>{field.value}</Markdown>
      )}
    </Text>
  );
}
