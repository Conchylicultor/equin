import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useTokenGroupEditor } from "@plugins/ui/plugins/theme-engine/plugins/theme-customizer/web";
import {
  ICON_FILLS,
  ICON_SHAPES,
  ICON_WEIGHTS,
  MATERIAL_FAMILY,
  symbol,
} from "@plugins/ui/plugins/icons/core";
import { Icon, useIconFamilies } from "@plugins/ui/plugins/icons/web";
import { iconsGroup } from "../../core";

type IconToken = keyof typeof iconsGroup.schema;

interface Option {
  id: string;
  label: string;
}

const optionLabel = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

const closed = (values: readonly string[]): readonly Option[] =>
  values.map((id) => ({ id, label: optionLabel(id) }));

// Every icon token is a choice, so each is a segmented control rather than the
// free-text row other groups use. The family's options are the contributed
// families (an open set), so they are read at render.
const TOKENS: readonly {
  token: IconToken;
  label: string;
  options: readonly Option[] | "families";
}[] = [
  { token: "iconFamily", label: "Family", options: "families" },
  { token: "iconShape", label: "Shape", options: closed(ICON_SHAPES) },
  { token: "iconFill", label: "Fill", options: closed(ICON_FILLS) },
  {
    token: "iconActiveFill",
    label: "Fill when active",
    options: closed(ICON_FILLS),
  },
  { token: "iconStroke", label: "Stroke", options: closed(ICON_WEIGHTS) },
];

// A few glyphs drawn in the scope's current style, at rest and active.
const PREVIEW = [
  symbol("home"),
  symbol("forum"),
  symbol("settings"),
  symbol("keep"),
];

function matches(search: string, token: IconToken, label: string): boolean {
  const q = search.trim().toLowerCase();
  return (
    !q || label.toLowerCase().includes(q) || iconsGroup.vars[token].includes(q)
  );
}

function TokenChoice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly Option[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Row
      actionsAlwaysVisible
      actions={
        <SegmentedControl options={options} value={value} onChange={onChange} />
      }
    >
      <Text as="span" variant="label">
        {label}
      </Text>
    </Row>
  );
}

export function IconsSection({ search }: { search: string }) {
  const editor = useTokenGroupEditor(iconsGroup);
  const families: readonly Option[] = [
    { id: MATERIAL_FAMILY, label: "Material" },
    ...useIconFamilies().map((f) => ({ id: f.id, label: f.label })),
  ];
  if (editor.pending) return <Loading variant="rows" count={TOKENS.length} />;

  // "both" edits light and dark together; the light value is what it shows.
  const shown = editor.values[editor.mode === "dark" ? "dark" : "light"];
  return (
    <Stack gap="xs">
      <Row
        actionsAlwaysVisible
        actions={
          <Stack direction="row" gap="sm">
            {PREVIEW.map((icon) => (
              <Icon key={icon.name} icon={icon} className="size-5" />
            ))}
            {PREVIEW.map((icon) => (
              <Icon
                key={`${icon.name}-active`}
                icon={icon}
                active
                className="size-5"
              />
            ))}
          </Stack>
        }
      >
        <Text as="span" variant="label">
          Preview (at rest, active)
        </Text>
      </Row>
      {TOKENS.filter(({ token, label }) => matches(search, token, label)).map(
        ({ token, label, options }) => (
          <TokenChoice
            key={token}
            label={label}
            options={options === "families" ? families : options}
            value={shown[token]!}
            onChange={(value) => editor.setToken(token, value)}
          />
        ),
      )}
    </Stack>
  );
}
