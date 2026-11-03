import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  TokenRows,
  useTokenGroupEditor,
} from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { fileTypePaletteGroup } from "../../core";

const KEYS = Object.keys(fileTypePaletteGroup.schema);

export function FileTypePaletteSection({ search }: { search: string }) {
  const editor = useTokenGroupEditor(fileTypePaletteGroup);
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
        group={fileTypePaletteGroup}
        keys={KEYS}
        search={search}
      />
    </Stack>
  );
}
