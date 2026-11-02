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
import { colorPaletteGroup } from "../../core";

interface GroupDef {
  label: string;
  keys: (keyof typeof colorPaletteGroup.schema)[];
}

const GROUPS: GroupDef[] = [
  { label: "Primary", keys: ["primary", "primaryForeground"] },
  { label: "Secondary", keys: ["secondary", "secondaryForeground"] },
  { label: "Accent", keys: ["accent", "accentForeground"] },
  { label: "Base", keys: ["background", "foreground"] },
  { label: "Card", keys: ["card", "cardForeground"] },
  { label: "Popover", keys: ["popover", "popoverForeground"] },
  { label: "Muted", keys: ["muted", "mutedForeground", "faintForeground"] },
  { label: "Destructive", keys: ["destructive", "destructiveForeground"] },
  { label: "Success", keys: ["success", "successForeground"] },
  { label: "Warning", keys: ["warning", "warningForeground"] },
  { label: "Info", keys: ["info", "infoForeground"] },
  { label: "Border & Input", keys: ["border", "input", "ring"] },
  { label: "Text roles", keys: ["strongForeground", "subtleForeground"] },
  {
    label: "Thread",
    keys: [
      "messageCard",
      "messageCardBorder",
      "threadCard",
      "threadCardBorder",
      "codeBorder",
    ],
  },
  {
    label: "Controls",
    keys: [
      "chip",
      "composer",
      "outlineBorder",
      "outlineFill",
      "outlineHover",
      "outlineHoverForeground",
      "toolbarForeground",
    ],
  },
];

export function ColorPaletteSection({ search }: { search: string }) {
  const editor = useTokenGroupEditor(colorPaletteGroup);
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
  const schema = colorPaletteGroup.schema;
  const vars = colorPaletteGroup.vars;
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
                group={colorPaletteGroup}
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
