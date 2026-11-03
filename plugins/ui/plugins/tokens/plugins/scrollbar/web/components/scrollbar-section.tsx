import {
  Collapsible,
  CollapsibleContent,
} from "@plugins/primitives/plugins/collapsible/web";
import { SectionHeaderRow } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  TokenRows,
  useTokenGroupEditor,
} from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { scrollbarGroup } from "../../core";

const KEYS = Object.keys(scrollbarGroup.schema);

// Every token row filters itself by `search`; whether this section appears at
// all is the contribution's `useAvailable` (`tokenGroupMatchesSearch`).
export function ScrollbarSection({ search }: { search: string }) {
  const editor = useTokenGroupEditor(scrollbarGroup);
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
      <Collapsible defaultOpen>
        <SectionHeaderRow variant="eyebrow">Tokens</SectionHeaderRow>
        <CollapsibleContent className="pl-sm">
          <TokenRows
            editor={editor}
            group={scrollbarGroup}
            keys={KEYS}
            search={search}
          />
        </CollapsibleContent>
      </Collapsible>
    </Stack>
  );
}
