import { useState, type FormEvent, type ReactNode } from "react";
import {
  Button,
  Input,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { transient } from "@plugins/primitives/plugins/kept-state/core";
import { localUndoProps } from "@plugins/primitives/plugins/undo-redo/web";
import { normalizeLinkUrl } from "@plugins/page/plugins/editor/web";

/** What an Apply hands back: the normalized href, and the new link text if it changed. */
export interface LinkFormResult {
  href: string;
  /**
   * The link text the user typed — present ONLY when the form has a Title field
   * AND its value differs from the one it opened with. Absent means "leave the
   * link's text alone", so an Apply that only touched the URL never rewrites
   * text somebody else changed while the form was open.
   */
  title?: string;
}

export interface LinkFormProps {
  /** The URL the field opens with (the link's current href, or "" for a new link). */
  initialUrl: string;
  /**
   * The link text the Title field opens with. Omit for a URL-only form (the
   * selection toolbar, where the text is whatever the user selected).
   */
  initialTitle?: string;
  /** Whether "Remove link" is offered — only when the target already is a link. */
  canRemove: boolean;
  onApply: (result: LinkFormResult) => void;
  onRemove: () => void;
  /** Escape. The host closes whatever holds the form. */
  onCancel: () => void;
}

/**
 * THE inline-link form: a URL field (plus an optional Title field), Enter or
 * Apply to commit, and Remove link. Shared by the selection toolbar's link
 * popover (URL only) and the link hover card's Edit mode (URL + Title), so the
 * validation and the Apply / Remove behaviour exist once.
 *
 * Validation is `normalizeLinkUrl` (`https://` / `mailto:` defaulting, the
 * allowed-protocol gate): an invalid URL disables Apply and an Enter does
 * nothing, keeping the form open for correction. An empty Title is invalid too
 * — a link with no text has nothing left to click.
 *
 * The form owns its field state and is mounted fresh each time its host opens,
 * so `initialUrl` / `initialTitle` are read once, at mount.
 */
export function LinkForm({
  initialUrl,
  initialTitle,
  canRemove,
  onApply,
  onRemove,
  onCancel,
}: LinkFormProps) {
  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState(initialTitle ?? "");
  const hasTitle = initialTitle !== undefined;

  const href = normalizeLinkUrl(url);
  const valid = href !== null && (!hasTitle || title.trim() !== "");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (href === null || !valid) return; // keep the form open for correction
    onApply(hasTitle && title !== initialTitle ? { href, title } : { href });
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <Stack gap="sm">
        <Field label={hasTitle ? "URL" : null}>
          <Input
            // NOT redundant, however portaled this looks. This field reads as
            // `local` today only because its host portals to `document.body`,
            // which severs it from the page body's `surfaceUndoProps` subtree so
            // `resolveUndoOwner`'s `closest()` walk finds nothing. That is an
            // accident: `PortalForwardProvider` re-stamps ancestry-derived `data-*`
            // across portals and already carries four, so the day
            // `data-undo-owner` joins them this flips to `surface` with no test to
            // catch it. Declared, the answer stays true either way.
            {...localUndoProps}
            autoFocus
            name="url"
            keep={transient(
              "a popover over the selection or link it edits: it closes with that anchor, which a reload does not reopen",
            )}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste or type a link"
          />
        </Field>
        {hasTitle && (
          <Field label="Title">
            <Input
              // Same reason as the URL field above.
              {...localUndoProps}
              name="title"
              keep={transient(
                "same popover as the URL field: closes with its anchor",
              )}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Link text"
            />
          </Field>
        )}
        <Line className="gap-xs">
          {canRemove && (
            <Button type="button" variant="ghost" onClick={onRemove}>
              Remove link
            </Button>
          )}
          <Fill />
          <Button type="submit" disabled={!valid}>
            Apply
          </Button>
        </Line>
      </Stack>
    </form>
  );
}

/**
 * One field. With a label, the `<label>` wraps its input (implicit association,
 * so no id plumbing); without one, the bare input — the toolbar popover's
 * single field reads as a URL box from its placeholder alone.
 */
function Field({
  label,
  children,
}: {
  label: string | null;
  children: ReactNode;
}) {
  if (label === null) return <>{children}</>;
  return (
    <Stack as="label" gap="2xs">
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      {children}
    </Stack>
  );
}
