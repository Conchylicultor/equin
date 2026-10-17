import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { ControlPanel } from "@plugins/primitives/plugins/css/plugins/control-panel/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { useActiveApp } from "@plugins/apps-core/web";
import { useScopeMembership } from "@plugins/config_v2/web";
import { themeSelectionConfig } from "@plugins/ui/plugins/theme-engine/core";
import {
  ThemeEngine,
  ThemeScopeProvider,
} from "@plugins/ui/plugins/theme-engine/web";
import { QuickTheme } from "../slots";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  runActivation,
  type Activation,
} from "@plugins/primitives/plugins/link-gesture/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const tuneIcon = symbol("tune");

/**
 * Every component variant picker (sidebar framing, tab bar, progress bar, …).
 * Each is a choice that survives a theme swap, so it is worth offering next to
 * the theme picker above — token values are never picked here, only through the
 * theme a scope selects.
 */
function ComponentVariantSection() {
  const hasAny = ThemeEngine.VariantGroup.useContributions().length > 0;
  if (!hasAny) return null;
  return (
    <ControlPanel.Section label="Variants">
      <Stack gap="md">
        <ThemeEngine.VariantGroup.Render>
          {(g) => (
            <Stack gap="2xs">
              <Text variant="label">{g.componentLabel}</Text>
              <g.component />
            </Stack>
          )}
        </ThemeEngine.VariantGroup.Render>
      </Stack>
    </ControlPanel.Section>
  );
}

/**
 * The quick-switch panel body: contributed quick sections on top (the theme
 * picker, then the light/dark switch — this file names neither, and their
 * order is reorder config's), every component variant picker below, and a footer
 * that hands off to the full customizer pane.
 *
 * It is a CONTROL PANEL body and therefore paints nothing of its own — no
 * padding, no scroll region, no bordered footer band. The `ControlPanelPopover`
 * that opens it owns the surface (and the scrolling), and the panel draws the
 * hairline above each band, which is why the footer here is a `Footer` rather
 * than an `Inset` with a `border-t`. Its action takes a leading `icon`, like
 * every footer in the vocabulary (invariant #4) — and this is the one panel
 * where that is visible: a footer row is still a row, so the ⚙ down here opens
 * the icon column and the variant rows above indent their labels 26px. The
 * alternative was three different treatments of one footer glyph across the
 * app, and uniformity won that trade.
 *
 * Scope resolution mirrors the customizer pane exactly — edits target the active
 * app's own theme once that app has been forked ("Customize for <App>" in the
 * pane), and base otherwise — so switching a theme from here and from the pane
 * write the same place. Forking itself stays a pane concern; this surface only
 * follows the choice already made there.
 */
export function QuickThemePanel({
  editor,
}: {
  /** Where "Open theme editor" goes: the customizer pane in the active app. */
  editor: Activation;
}) {
  const activeApp = useActiveApp();
  const scopeId = activeApp ? `app:${activeApp.id}` : undefined;
  const membership = useScopeMembership(themeSelectionConfig, scopeId);
  // Which scope a pick lands in is what membership decides: nothing to pick
  // until it is known (preloaded: settled after a successful boot). Under a
  // transient error the last-known answer stands.
  const forked = foldResource(membership, {
    loading: () => undefined,
    error: (_error, stale) => stale,
    ready: (member) => member,
  });
  if (forked === undefined) {
    return membership.status === "error" ? (
      <ResourceErrorInline
        variant="block"
        subject="the theme scope"
        error={membership.error}
        refetch={membership.refetch}
      />
    ) : (
      <Loading />
    );
  }
  const effectiveScopeId = forked && scopeId ? scopeId : undefined;

  return (
    <ThemeScopeProvider scopeId={effectiveScopeId}>
      {/* The popover is the scroll owner: sections render at natural height, so
          the panel's overall length is what scrolls. The one sanctioned
          exception is a section whose content is unbounded by nature (the
          500-entry theme catalog) — it bounds itself so the sections below it
          stay reachable. */}
      <QuickTheme.Section.Render>
        {(s) => (
          <ControlPanel.Section label={s.label} needs={s.needs}>
            <s.component />
          </ControlPanel.Section>
        )}
      </QuickTheme.Section.Render>
      <ComponentVariantSection />
      <ControlPanel.Footer>
        <ControlPanel.Row
          icon={<Icon icon={tuneIcon} />}
          // A panel row selects; it has no link gestures to spread yet.
          onSelect={() => runActivation(editor)}
        >
          Open theme editor
        </ControlPanel.Row>
      </ControlPanel.Footer>
    </ThemeScopeProvider>
  );
}
