import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  TokenRows,
  useTokenGroupEditor,
} from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { placePaletteGroup } from "../../core";

const KEYS = Object.keys(placePaletteGroup.schema);

export function PlacePaletteSection({ search }: { search: string }) {
  const editor = useTokenGroupEditor(placePaletteGroup);
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
        group={placePaletteGroup}
        keys={KEYS}
        search={search}
      />
    </Stack>
  );
}
