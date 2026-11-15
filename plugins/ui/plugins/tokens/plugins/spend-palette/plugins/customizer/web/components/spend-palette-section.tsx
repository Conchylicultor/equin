import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  TokenRows,
  useTokenGroupEditor,
} from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { spendPaletteGroup } from "@plugins/ui/plugins/tokens/plugins/spend-palette/core";

const KEYS = Object.keys(spendPaletteGroup.schema);

export function SpendPaletteSection({ search }: { search: string }) {
  const editor = useTokenGroupEditor(spendPaletteGroup);
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
    <Stack gap="2xs">
      <TokenRows
        editor={editor}
        group={spendPaletteGroup}
        keys={KEYS}
        search={search}
      />
    </Stack>
  );
}
