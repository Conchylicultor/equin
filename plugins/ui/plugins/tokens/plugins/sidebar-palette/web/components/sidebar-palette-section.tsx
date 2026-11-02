import {
  Collapsible,
  CollapsibleContent,
} from "@plugins/primitives/plugins/collapsible/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { SectionHeaderRow } from "@plugins/primitives/plugins/css/plugins/row/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  TokenRows,
  useTokenGroupEditor,
} from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import { sidebarPaletteGroup } from "../../core";

interface GroupDef {
  label: string;
  keys: (keyof typeof sidebarPaletteGroup.schema)[];
}

const GROUPS: GroupDef[] = [
  { label: "Base", keys: ["sidebar", "sidebarForeground", "sidebarIcon"] },
  { label: "Primary", keys: ["sidebarPrimary", "sidebarPrimaryForeground"] },
  { label: "Accent", keys: ["sidebarAccent", "sidebarAccentForeground"] },
  { label: "Border", keys: ["sidebarBorder", "sidebarRing"] },
];

export function SidebarPaletteSection({ search }: { search: string }) {
  const editor = useTokenGroupEditor(sidebarPaletteGroup);
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
    return <Loading variant="rows" count={GROUPS.length} />;
  }

  const shown =
    editor.mode === "dark" ? editor.values.dark : editor.values.light;
  const schema = sidebarPaletteGroup.schema;
  const vars = sidebarPaletteGroup.vars;
  const q = search.toLowerCase();

  return (
    <Stack gap="2xs">
      {GROUPS.map((group) => {
        // A sub-group none of whose tokens answers the search box disappears.
        const visibleKeys = group.keys.filter((key) => {
          if (!q) return true;
          const label = schema[key]?.label ?? key;
          const cssVar = vars[key] ?? "";
          return (
            label.toLowerCase().includes(q) || cssVar.toLowerCase().includes(q)
          );
        });
        if (visibleKeys.length === 0) return null;

        return (
          <Collapsible key={group.label}>
            <SectionHeaderRow
              variant="eyebrow"
              actions={group.keys.map((key) => (
                <span
                  key={key}
                  className="size-2 rounded-full border border-border/30"
                  style={{ backgroundColor: shown[key] }}
                />
              ))}
            >
              {group.label}
            </SectionHeaderRow>
            <CollapsibleContent className="pl-sm">
              <TokenRows
                editor={editor}
                group={sidebarPaletteGroup}
                keys={visibleKeys}
                search={search}
              />
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </Stack>
  );
}
