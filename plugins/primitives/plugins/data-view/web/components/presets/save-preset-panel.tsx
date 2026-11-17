import type { ReactNode } from "react";
import { z } from "zod";
import { Input } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  defineKept,
  useKept,
} from "@plugins/primitives/plugins/kept-state/web";
import {
  ControlPanel,
  usePanelStack,
} from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { useDataViewControls } from "../controls/controls-context";

const bookmarkAddIcon = symbol("bookmark-add");

/** A preset name typed and not yet saved, per DataView and preset kind. */
const presetNameDraft = defineKept({
  owner: "data-view.preset-name",
  label: "Preset names",
  tier: "work",
  cap: "8 KB",
  schema: z.string(),
});

/**
 * The pushed "Save as preset" page — a name field over a Save row. Enter submits,
 * an empty name disables Save, and saving pops back to the panel you came from.
 *
 * It is a PAGE and not a popover, which is the whole change: the footer used to
 * open an `InlinePopover` from inside the panel's own popover, so naming a preset
 * meant a second floating layer with its own width, its own clamp and its own
 * dismissal, stacked over the first.
 *
 * Both callers wrap it in a component that reads the live state it captures, so
 * "what gets saved" is whatever is in force when Save is pressed — never a
 * snapshot taken when the row was clicked.
 */
export function SavePresetPanel({
  kind,
  onSave,
}: {
  /** Which presets it names: the filter and sort name drafts are kept apart. */
  kind: "filter" | "sort";
  onSave: (label: string) => void;
}): ReactNode {
  const { pop } = usePanelStack();
  const { storageKey } = useDataViewControls();
  const nameKept = useKept(presetNameDraft, "", {
    subject: `${storageKey}|${kind}`,
  });
  const [name, , clearName] = nameKept;

  const submit = () => {
    const label = name.trim();
    if (label === "") return;
    onSave(label);
    clearName();
    pop();
  };

  return (
    <>
      <ControlPanel.Section>
        <Input
          autoFocus
          keep={nameKept}
          placeholder="Preset name…"
          aria-label="Preset name"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
      </ControlPanel.Section>
      <ControlPanel.Footer>
        <ControlPanel.Row
          icon={<Icon icon={bookmarkAddIcon} />}
          disabled={name.trim() === ""}
          onSelect={submit}
        >
          Save preset
        </ControlPanel.Row>
      </ControlPanel.Footer>
    </>
  );
}
