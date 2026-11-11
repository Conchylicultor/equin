import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { useState } from "react";
import { PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { SearchInput } from "@plugins/primitives/plugins/search/web";
import { useScopeMembership } from "@plugins/config_v2/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { forkScope, deleteScope } from "@plugins/config_v2/core";
import { useCurrentAppId } from "@plugins/apps-core/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { themeSelectionConfig } from "@plugins/ui/plugins/theme-engine/core";
import {
  ThemeEngine,
  ThemeScopeProvider,
  usePreviewColorScheme,
} from "@plugins/ui/plugins/theme-engine/web";
import { themeCustomizerPane } from "../panes";
import { ThemeCustomizer } from "../slots";
import {
  TokenModeContext,
  type TokenMode,
} from "../internal/token-mode-context";
import { Loading } from "@plugins/primitives/plugins/loading/web";

// Pickers for pluggable-component variants (sidebar framing, progress bar, …),
// each registered via `ThemeEngine.VariantGroup`. Scope follows the surrounding
// `ThemeScopeProvider`, so a forked app edits its own variant selection.
function VariantGroupSection() {
  const groups = ThemeEngine.VariantGroup.useContributions();
  if (groups.length === 0) return null;
  return (
    <Stack gap="lg">
      <ThemeEngine.VariantGroup.Render>
        {(g) => (
          <Stack gap="xs">
            <Text variant="label">{g.componentLabel}</Text>
            <g.component />
          </Stack>
        )}
      </ThemeEngine.VariantGroup.Render>
    </Stack>
  );
}

const TOKEN_MODES: { id: TokenMode; label: string }[] = [
  { id: "both", label: "Both" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function TokenModeSelector({
  mode,
  onChange,
}: {
  mode: TokenMode;
  onChange: (m: TokenMode) => void;
}) {
  return (
    <Grid cols={TOKEN_MODES.length} gap="xs">
      {TOKEN_MODES.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={`py-xs text-caption font-medium rounded-md border transition-colors ${
            mode === id
              ? "border-primary bg-primary/10 text-primary-text"
              : "border-border text-muted-foreground hover:border-primary/50"
          }`}
        >
          {label}
        </button>
      ))}
    </Grid>
  );
}

// "Customize for this app" toggle. OFF→ON forks the whole `scope: "app"` set so
// edits diverge from base; ON→OFF un-forks and the app tracks base live again.
// Hidden when no app is active (appId undefined). Labels with the app name.
function CustomizeForAppToggle({
  appId,
  scopeId,
  forked,
}: {
  appId: string;
  scopeId: string;
  forked: boolean;
}) {
  const { mutate: deleteScopeMutation } = useEndpointMutation(deleteScope);
  const { mutate: forkScopeMutation } = useEndpointMutation(forkScope);
  const appLabel = appId.charAt(0).toUpperCase() + appId.slice(1);
  const onToggle = () => {
    if (forked) {
      deleteScopeMutation({ body: { scopeId } });
    } else {
      forkScopeMutation({ body: { scopeId } });
    }
  };
  return (
    <Line
      as="button"
      type="button"
      onClick={onToggle}
      className={`gap-md px-md py-sm text-body rounded-md border transition-colors ${
        forked
          ? "border-primary bg-primary/10 text-primary-text"
          : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
      }`}
    >
      {/* The label is the row's one grow cell, so the switch sits flush right. */}
      <Fill as="span" className="font-medium">
        Customize for {appLabel}
      </Fill>
      <Inline
        gap="none"
        className={`relative h-4 w-7 rounded-full transition-colors ${
          forked ? "bg-primary" : "bg-muted-foreground/30"
        }`}
      >
        <span
          className={`inline-block size-3 rounded-full bg-background transition-transform ${
            forked ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </Inline>
    </Line>
  );
}

export function ThemeCustomizerBody() {
  const [search, setSearch] = useState("");
  const [tokenMode, setTokenMode] = useState<TokenMode>("both");
  const appId = useCurrentAppId();
  const scopeId = appId ? `app:${appId}` : undefined;
  // "Has its own theme" = this app has its own theme selection document
  // (committed git scope OR runtime fork). The toggle means that membership.
  const membership = useScopeMembership(themeSelectionConfig, scopeId);

  // Editing one mode's tokens shows the app being edited (the desktop with
  // none) in that mode, without writing its setting; "both" shows it as set.
  usePreviewColorScheme(
    appId ?? undefined,
    tokenMode === "both" ? undefined : tokenMode,
  );

  // Which scope an edit lands in is exactly what membership decides, so nothing
  // is editable until it is known (preloaded: settled after a successful boot).
  // Under a transient error the last-known answer stands, so the panel (and its
  // search text) is not torn down.
  const forked = foldResource(membership, {
    loading: () => undefined,
    error: (_error, stale) => stale,
    ready: (member) => member,
  });
  if (forked === undefined) {
    return (
      <PaneChrome pane={themeCustomizerPane}>
        {membership.status === "error" ? (
          <ResourceErrorInline
            variant="block"
            subject="the theme scope"
            error={membership.error}
            refetch={membership.refetch}
          />
        ) : (
          <Loading />
        )}
      </PaneChrome>
    );
  }
  // Edits route to the app scope only once it has its own theme; else they target base.
  const effectiveScopeId = forked && scopeId ? scopeId : undefined;

  return (
    <PaneChrome pane={themeCustomizerPane}>
      <ThemeScopeProvider scopeId={effectiveScopeId}>
        <Stack gap="lg">
          <Stack gap="lg" className="px-xl pt-lg">
            {appId && scopeId && (
              <CustomizeForAppToggle
                appId={appId}
                scopeId={scopeId}
                forked={forked}
              />
            )}
            <VariantGroupSection />
            <TokenModeSelector mode={tokenMode} onChange={setTokenMode} />
            <SearchInput
              placeholder="Filter sections..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Stack>
          <TokenModeContext.Provider value={tokenMode}>
            <ThemeCustomizer.Host search={search} />
          </TokenModeContext.Provider>
        </Stack>
      </ThemeScopeProvider>
    </PaneChrome>
  );
}
