import {
  Collapsible,
  CollapsibleContent,
} from "@plugins/primitives/plugins/collapsible/web";
import { SectionHeaderRow } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  TokenRows,
  useTokenGroupEditor,
  FillFromMenu,
} from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { densityGroup } from "../../core";
import { densityShortcuts } from "../shortcuts";

// The ramp's in-between steps (`space-xsm`, `space-smd`) are derived — their
// default reads their neighbours' vars (see the group) — not settings: editing
// one here would pin a number that no longer follows the preset and could
// cross a neighbour. So the customizer lists the neighbours and leaves out
// every ramp step whose default is derived from another, read off the schema
// so a new in-between step is left out with no edit here.
function isDerivedRampStep(key: string): boolean {
  const field = densityGroup.schema[key as keyof typeof densityGroup.schema];
  return key.startsWith("space-") && field.default.includes("var(--space-");
}

const KEYS = Object.keys(densityGroup.schema).filter(
  (key) => !isDerivedRampStep(key),
);

// Every token row filters itself by `search`; whether this section appears at
// all is the contribution's `useAvailable` (`tokenGroupMatchesSearch`).
export function DensitySection({ search }: { search: string }) {
  const editor = useTokenGroupEditor(densityGroup);
  if (editor.pending) {
    if (editor.error !== null) {
      return (
        <ResourceErrorInline
          error={editor.error}
          refetch={editor.refetch}
          variant="block"
          subject="the theme selection"
        />
      );
    }
    return <Loading variant="rows" count={KEYS.length} />;
  }

  return (
    <Stack gap="xs">
      <FillFromMenu
        shortcuts={densityShortcuts}
        onFill={(shortcut) => editor.fillFrom(shortcut.fragment)}
      />
      <Collapsible defaultOpen>
        <SectionHeaderRow variant="eyebrow">Tokens</SectionHeaderRow>
        <CollapsibleContent className="pl-sm">
          <TokenRows
            editor={editor}
            group={densityGroup}
            keys={KEYS}
            search={search}
          />
        </CollapsibleContent>
      </Collapsible>
    </Stack>
  );
}
