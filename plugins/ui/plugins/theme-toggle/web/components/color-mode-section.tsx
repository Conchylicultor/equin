import type React from "react";
import { useCurrentAppId } from "@plugins/apps-core/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import type {
  AppColorModeOverride,
  ConfiguredColorMode,
} from "@plugins/ui/plugins/theme-engine/core";
import {
  useColorModeSettingFor,
  useSetAppColorMode,
  useSetGlobalColorMode,
  type ColorModeSetting,
} from "@plugins/ui/plugins/theme-engine/web";

const SEARCH_TERMS = ["color mode", "dark", "light", "system", "appearance"];

/** Whether the section answers the customizer's search box. */
export function useColorModeMatchesSearch({
  search,
}: {
  search: string;
}): boolean {
  const q = search.trim().toLowerCase();
  return q.length === 0 || SEARCH_TERMS.some((term) => term.includes(q));
}

const MODE_LABEL: Record<ConfiguredColorMode, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const GLOBAL_OPTIONS: { id: ConfiguredColorMode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** What `default` means for this app, in words: its declared default. */
function defaultMeaning(setting: ColorModeSetting): string {
  const declared = setting.app?.declared;
  return declared === undefined || declared === "global"
    ? "Default: follows the global setting."
    : `Default: ${MODE_LABEL[declared]}, as this app is designed.`;
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Stack gap="xs">
      <Text variant="label">{label}</Text>
      {children}
      <Text variant="caption" tone="muted">
        {description}
      </Text>
    </Stack>
  );
}

/**
 * The colour scheme, in the customizer: the current app's own choice (its
 * declared default, or an override — `global` among them), and the global
 * setting every app that follows it wears. Independent of "Customize for
 * <App>": a scheme is not part of a theme, and picking one never forks it.
 */
export function ColorModeSection() {
  const appId = useCurrentAppId();
  return (
    <Stack gap="lg">
      {appId !== undefined && <AppColorModeSetting appId={appId} />}
      <GlobalColorModeSetting />
    </Stack>
  );
}

function AppColorModeSetting({ appId }: { appId: string }) {
  const setting = useColorModeSettingFor(appId);
  const set = useSetAppColorMode(appId);
  const options: { id: AppColorModeOverride; label: string }[] = [
    { id: "default", label: "Default" },
    { id: "global", label: "Global" },
    { id: "system", label: "System" },
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
  ];
  return (
    <Field label="This app" description={defaultMeaning(setting)}>
      <SegmentedControl
        label="This app's color mode"
        options={options}
        value={setting.app?.override ?? "default"}
        onChange={set}
        variant="ghost"
      />
    </Field>
  );
}

function GlobalColorModeSetting() {
  const setting = useColorModeSettingFor(undefined);
  const set = useSetGlobalColorMode();
  return (
    <Field
      label="Every app"
      description="What every app that follows the global setting wears."
    >
      <SegmentedControl
        label="Global color mode"
        options={GLOBAL_OPTIONS}
        value={setting.global}
        onChange={set}
        variant="ghost"
      />
    </Field>
  );
}
