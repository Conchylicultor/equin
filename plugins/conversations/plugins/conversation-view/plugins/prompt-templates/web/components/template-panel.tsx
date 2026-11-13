import { useCallback, useState } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { ConfigGearButton } from "@plugins/config_v2/plugins/config-link/web";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

import type { TemplateChipItem } from "./template-chip";
import { TemplateEditor, type TemplateDraft } from "./template-editor";

const editIcon = symbol("edit");
const sendIcon = symbol("send");
const addIcon = symbol("add");

/** Editing the template list in place: the whole list, handed back changed. */
export interface TemplateListEdit {
  /**
   * Store the changed list. Answers whether it was taken: on `false` (refused,
   * and said so) the editor stays open with what was typed.
   */
  onChange: (templates: TemplateChipItem[]) => boolean;
  /** A new template's first prompt, read when its editor opens (e.g. the draft). */
  initialPrompt?: () => string;
}

export interface TemplatePanelProps {
  /** Every template, usage-ranked. */
  ordered: readonly TemplateChipItem[];
  /** The list in its authored order — what an edit rewrites. */
  templates: readonly TemplateChipItem[];
  onInsert: (t: TemplateChipItem) => void;
  onSend: (t: TemplateChipItem) => void;
  canSend: boolean;
  edit?: TemplateListEdit;
  config: ConfigDescriptor;
  configLabel: string;
}

type Editing =
  | { kind: "none" }
  | { kind: "new"; prompt: string }
  | { kind: "edit"; id: string };

/**
 * The ✎ panel: every template as a row (click inserts, ✎ edits it in place,
 * ➤ sends), and a footer with + New template and the config gear. With `edit`,
 * the panel is the whole template editor — add, rename, rewrite, delete —
 * Settings is only needed for the rest of the config.
 */
export function TemplatePanel({
  ordered,
  templates,
  onInsert,
  onSend,
  canSend,
  edit,
  config,
  configLabel,
}: TemplatePanelProps) {
  const [editing, setEditing] = useState<Editing>({ kind: "none" });
  const close = useCallback(() => setEditing({ kind: "none" }), []);

  function saveNew(d: TemplateDraft) {
    // Appended last: the authored order is the never-used tie-break, so a new
    // template sits after the ones already there.
    if (edit?.onChange([...templates, { id: crypto.randomUUID(), ...d }]))
      close();
  }
  function saveEdit(id: string, d: TemplateDraft) {
    if (
      edit?.onChange(templates.map((t) => (t.id === id ? { ...t, ...d } : t)))
    )
      close();
  }
  function remove(id: string) {
    if (edit?.onChange(templates.filter((t) => t.id !== id))) close();
  }

  return (
    <Stack gap="xs" className="w-80">
      {(ordered.length > 0 || editing.kind === "new") && (
        <Scroll className="max-h-72">
          <Stack gap="none">
            {/* eslint-disable-next-line data-view/no-adhoc-row-list -- a hover picker's menu rows (insert / edit / send), transient chrome over a handful of configured templates */}
            {ordered.map((t) =>
              editing.kind === "edit" && editing.id === t.id ? (
                <TemplateEditor
                  key={t.id}
                  mode="edit"
                  initial={t}
                  onSave={(d) => saveEdit(t.id, d)}
                  onDelete={() => remove(t.id)}
                  onClose={close}
                />
              ) : (
                <Row
                  key={t.id}
                  size="sm"
                  title={t.prompt}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onInsert(t)}
                  actions={
                    <>
                      {edit && (
                        <IconButton
                          icon={editIcon}
                          label={`Edit: ${t.title}`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => setEditing({ kind: "edit", id: t.id })}
                        />
                      )}
                      <IconButton
                        icon={sendIcon}
                        label={`Send: ${t.title}`}
                        disabled={!canSend}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onSend(t)}
                      />
                    </>
                  }
                >
                  <Text className={rigidClass()}>{t.title}</Text>
                  <Text tone="muted">{t.prompt}</Text>
                </Row>
              ),
            )}
            {editing.kind === "new" && (
              <TemplateEditor
                mode="new"
                initial={{ title: "", prompt: editing.prompt }}
                onSave={saveNew}
                onClose={close}
              />
            )}
          </Stack>
        </Scroll>
      )}
      <Stack direction="row" gap="xs" align="center" justify="between">
        {edit ? (
          <Button
            variant="ghost"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              setEditing({
                kind: "new",
                prompt: edit.initialPrompt?.().trim() ?? "",
              })
            }
          >
            <Icon icon={addIcon} className="size-3.5" />
            <span>New template</span>
          </Button>
        ) : (
          <span />
        )}
        <ConfigGearButton descriptor={config} label={configLabel} />
      </Stack>
    </Stack>
  );
}
