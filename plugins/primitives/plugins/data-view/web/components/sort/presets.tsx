import type { ReactNode } from "react";
import { showToast } from "@plugins/shell/plugins/toast/web";
import { useSortPresets } from "../../internal/use-sort-presets";
import {
  applyPresetRules,
  presetMatchesRules,
  resolvableRules,
} from "../../internal/sort-presets";
import { useDataViewControls } from "../controls/controls-context";
import { PresetSection, type PresetEntry } from "../presets/preset-section";
import { SavePresetPanel } from "../presets/save-preset-panel";

/**
 * The sort panel's two preset surfaces, each reading the presets config LIVE.
 *
 * They are two components and not one because the second is a pushed page: a
 * panel-stack entry's `render` closure is captured when the row is clicked, so a
 * page handed its data as a prop would keep showing what was true then. Reading
 * the hooks inside the page instead makes that impossible.
 */

/** Live entries for the current surface, plus the controller behind them. */
function useSortPresetEntries(): {
  entries: PresetEntry[];
  apply: (id: string) => void;
  deletePreset: (id: string) => void;
} {
  const { storageKey, sort } = useDataViewControls();
  const presets = useSortPresets(storageKey);

  const entries = presets.presets.map((preset) => ({
    id: preset.id,
    label: preset.label,
    active: presetMatchesRules(preset, sort.rules),
    // A preset whose every field has since left the schema can still be deleted
    // — `disabled` scopes to the row's SELECTION, not its actions — but applying
    // it would do nothing, so the row says so instead of no-oping.
    applicable: resolvableRules(preset.rules, sort.sortableFields).length > 0,
  }));

  return {
    entries,
    // Apply writes the preset's RESOLVABLE rules into the live sort behind the
    // pinned prefix, so a preset that half-resolves applies the half that does
    // and never displaces a pin.
    apply: (id) => {
      const preset = presets.presets.find((p) => p.id === id);
      if (preset) {
        sort.setRules(
          applyPresetRules(sort.rules, preset.rules, sort.sortableFields),
        );
      }
    },
    // The row's trash is one click and takes the whole rule list with it, which
    // nothing can reconstruct — so the preset AND its position are captured
    // before the delete and handed to the toast's Undo. Restoring at the end of
    // the list would be a different list, so the index travels too.
    deletePreset: (id) => {
      const index = presets.presets.findIndex((p) => p.id === id);
      const preset = presets.presets[index];
      if (!preset) {
        // The only rows that can fire this are rows built from this same list,
        // so a miss is a bug in the wiring, not a state a user can reach.
        throw new Error(`data-view: no sort preset "${id}" to delete.`);
      }
      presets.deletePreset(id);
      showToast({
        description: `Deleted preset “${preset.label}”`,
        action: {
          label: "Undo",
          onClick: () => presets.restorePreset(preset, index),
        },
      });
    },
  };
}

/** The "Presets" section at the top of the sort panel. Null when there are none. */
export function SortPresetSection(): ReactNode {
  const { entries, apply, deletePreset } = useSortPresetEntries();
  return (
    <PresetSection entries={entries} onApply={apply} onDelete={deletePreset} />
  );
}

/** The pushed "Save as preset" page — captures the live USER rules on submit
 *  (pinned rules belong to the view, not the preset). */
export function SortSavePresetPanel(): ReactNode {
  const { storageKey, sort } = useDataViewControls();
  const presets = useSortPresets(storageKey);
  return (
    <SavePresetPanel
      onSave={(label) => presets.savePreset(label, sort.rules)}
    />
  );
}
