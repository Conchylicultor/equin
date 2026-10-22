import { Icon } from "@plugins/ui/plugins/icons/web";
import { useState } from "react";
import { openDialog } from "@plugins/primitives/plugins/overlay/plugins/imperative-dialog/web";
import { useSetConfig } from "@plugins/config_v2/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { DialogTitle } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { wallpaperConfig, type WallpaperCandidate } from "../../core";
import { Wallpaper } from "../slots";
import { saveCandidate } from "../internal/save";

/**
 * Open the wallpaper picker as a modal dialog. One tab per registered
 * {@link Wallpaper.Provider} (collection-consumer — never names a provider). On
 * pick, the dialog centralizes saving: it funnels the candidate through the
 * server save path, then writes `wallpaperConfig` (the single config-write site),
 * then closes.
 */
export function openWallpaperPicker(): void {
  void openDialog((close) => <WallpaperPickerDialog onClose={close} />, {
    size: "md",
  });
}

function WallpaperPickerDialog({ onClose }: { onClose: () => void }) {
  const providers = Wallpaper.Provider.useContributions();
  const setConfig = useSetConfig(wallpaperConfig);
  const fetchEndpoint = useFetchEndpoint();
  const [activeId, setActiveId] = useState(providers[0]?.id ?? "");
  const [saving, setSaving] = useState(false);

  const active = providers.find((p) => p.id === activeId) ?? providers[0];

  const onPick = async (candidate: WallpaperCandidate) => {
    if (saving) return;
    if (candidate.kind === "builtin") {
      setConfig("state", {
        kind: "builtin",
        id: candidate.id,
        version: 0,
        mime: "",
        attribution: {},
      });
      onClose();
      return;
    }
    setSaving(true);
    try {
      const saved = await saveCandidate(fetchEndpoint, candidate);
      // The picker is the single owner of the config write — providers/endpoints
      // never touch config. Global write (no scopeId).
      setConfig("state", {
        kind: "image",
        id: "",
        version: saved.version,
        mime: saved.mime,
        attribution: candidate.attribution ?? {},
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack gap="md">
      <DialogTitle>Change wallpaper</DialogTitle>
      {providers.length === 0 ? (
        <Placeholder>No wallpaper sources are installed.</Placeholder>
      ) : (
        <Stack gap="md">
          {providers.length > 1 && (
            <SegmentedControl
              value={activeId}
              onChange={setActiveId}
              options={providers.map((p) => ({
                id: p.id,
                label: p.label,
                icon: p.icon ? <Icon icon={p.icon} /> : undefined,
              }))}
            />
          )}
          {active && <active.Panel onPick={(c) => void onPick(c)} />}
          {saving && (
            <Text variant="caption" tone="muted">
              Saving…
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}
