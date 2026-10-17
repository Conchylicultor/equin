import type { ReactElement } from "react";
import type { Exhibit } from "@plugins/plugin-meta/plugins/exhibits/core";
import { Apps } from "@plugins/apps-core/web";
import { chromeThemeScope } from "@plugins/apps-core/plugins/chrome-theme/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  appThemeScope,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { ExhibitView } from "./exhibit-view";
import { ExhibitBadges, widthsOf } from "./exhibit-meta";

/** The `;theme` value naming the app chrome's fixed theme (rail, tab bar, action bar). */
export const CHROME_THEME = "chrome";

interface ThemeOption {
  /** The `;theme` route value. */
  value: string;
  label: string;
  /** The `data-theme-scope` token the frames wear. */
  scope: string;
}

/** The `;theme` value an exhibit opens in: where it lives, else this pane's own app. */
function defaultThemeOf(exhibit: Exhibit): string {
  const { home } = exhibit;
  if (home === undefined) return debugApp.id;
  return home === "chrome" ? CHROME_THEME : home.id;
}

/**
 * Every theme an exhibit can be viewed in: each installed app's and the app
 * chrome's. The exhibit's default comes first, labelled with why it is the
 * default — its home, or Debug (this pane's own app) for an exhibit that lives
 * in no one app.
 */
function useThemeOptions(exhibit: Exhibit): readonly ThemeOption[] {
  const apps = Apps.App.useContributions();
  const fallback = defaultThemeOf(exhibit);
  const all: ThemeOption[] = [
    ...apps.map((a) => ({
      value: a.app.id,
      label: a.app.name,
      scope: appThemeScope(a.app.id),
    })),
    { value: CHROME_THEME, label: "App chrome", scope: chromeThemeScope },
  ];
  const note = exhibit.home === undefined ? "this pane's app" : "its home";
  const first = all.find((o) => o.value === fallback);
  return first === undefined
    ? all
    : [
        { ...first, label: `${first.label} (${note})` },
        ...all.filter((o) => o !== first),
      ];
}

function ThemePicker({
  options,
  value,
  onPick,
}: {
  options: readonly ThemeOption[];
  value: string;
  onPick: (theme: string) => void;
}): ReactElement {
  const labelOf = (v: string): string =>
    options.find((o) => o.value === v)?.label ?? `Unknown theme "${v}"`;
  return (
    <Stack direction="row" gap="sm" align="center">
      <Text variant="label" tone="muted">
        Theme
      </Text>
      <Select
        items={options.map((o) => ({ value: o.value, label: o.label }))}
        value={value}
        onValueChange={(v: string | null) => {
          if (v !== null) onPick(v);
        }}
      >
        <SelectTrigger aria-label="Theme">
          <SelectValue>
            {(v: string | null) => (v === null ? "" : labelOf(v))}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Stack>
  );
}

/**
 * One exhibit, at each of its widths, inside ONE theme boundary the viewer
 * picks. Without a boundary the frames would silently wear this pane's home
 * app's theme (Debug) — wherever the component really lives — so the theme is
 * always explicit: the exhibit's declared `home` by default, named in the
 * picker and carried in the URL (`;theme`) once picked.
 */
export function ExhibitDetail({
  exhibit,
  theme,
  onTheme,
}: {
  exhibit: Exhibit;
  /** The `;theme` route value; absent = the exhibit's default (`defaultThemeOf`). */
  theme: string | undefined;
  onTheme: (theme: string) => void;
}): ReactElement {
  const options = useThemeOptions(exhibit);
  const value = theme ?? defaultThemeOf(exhibit);
  const picked = options.find((o) => o.value === value);
  return (
    <Scroll fill axis="both">
      <Inset pad="lg">
        <Stack gap="lg">
          <Stack gap="xs">
            <Stack direction="row" gap="sm" align="center" wrap>
              <Text variant="title">{exhibit.label}</Text>
              <ExhibitBadges exhibit={exhibit} />
            </Stack>
            <Stack direction="row" gap="2xs" align="center">
              <Text variant="code" tone="muted">
                {exhibit.id}
              </Text>
              <CopyButton
                text={exhibit.id}
                tooltip="Copy exhibit id"
                aspect="inline"
              />
            </Stack>
            {exhibit.description === undefined ? null : (
              <Text variant="body" tone="muted">
                {exhibit.description}
              </Text>
            )}
          </Stack>
          <ThemePicker options={options} value={value} onPick={onTheme} />
          {picked === undefined ? (
            <Text variant="body" tone="destructive">
              No installed app or fixed theme is called “{value}”
              {theme === undefined ? " (this exhibit's declared home)" : ""}.
            </Text>
          ) : (
            // One boundary around every frame: the canvas paint shows the
            // picked theme's background behind the cards, not the pane's.
            <Theme name={picked.scope} surface="canvas" data-exhibit-frames="">
              <Inset pad="md">
                <Stack gap="lg" align="start">
                  {widthsOf(exhibit).map((width) => (
                    <Stack key={width} gap="2xs">
                      <Text variant="caption" tone="muted">
                        {width}px
                      </Text>
                      {/*
                        One cell per width: `ExhibitView` wraps each in its own
                        error boundary, so a crash costs its cell, never the pane.
                      */}
                      <Card>
                        <ExhibitView exhibit={exhibit} width={width} />
                      </Card>
                    </Stack>
                  ))}
                </Stack>
              </Inset>
            </Theme>
          )}
        </Stack>
      </Inset>
    </Scroll>
  );
}
