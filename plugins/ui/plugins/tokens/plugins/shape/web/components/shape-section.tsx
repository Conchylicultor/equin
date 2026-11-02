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
import { shapeGroup } from "../../core";
import { shapeShortcuts } from "../shortcuts";

const KEYS = Object.keys(shapeGroup.schema);

// Every token row filters itself by `search`; whether this section appears at
// all is the contribution's `useAvailable` (`tokenGroupMatchesSearch`).
export function ShapeSection({ search }: { search: string }) {
  const editor = useTokenGroupEditor(shapeGroup);
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
        shortcuts={shapeShortcuts}
        onFill={(shortcut) => editor.fillFrom(shortcut.fragment)}
      />
      <Collapsible defaultOpen>
        <SectionHeaderRow variant="eyebrow">Tokens</SectionHeaderRow>
        <CollapsibleContent className="pl-sm">
          <TokenRows
            editor={editor}
            group={shapeGroup}
            keys={KEYS}
            search={search}
          />
        </CollapsibleContent>
      </Collapsible>
    </Stack>
  );
}
