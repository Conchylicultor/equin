import type { ReactNode } from "react";
import { hostFsVolumeInfo } from "@plugins/infra/plugins/host-fs/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { formatSize } from "@plugins/apps/plugins/file-explorer/plugins/browser/core";

/** On the places' icon column: the sidebar's rail plus a row's own padding. */
const METER_INSET = {
  paddingInline: "calc(var(--sidebar-rail) + var(--sidebar-row-pad-x))",
};

/**
 * The startup volume's storage, at the foot of the Places sidebar: its name,
 * a bar filled to the used fraction, and "X GB free of Y GB". Free space is
 * a `host-fs.volume` snapshot — measured as the sidebar mounts (nothing
 * signals a change). Renders nothing until the volume has answered — a meter
 * at zero would claim an empty disk — nor when it cannot (the startup-volume
 * place above says why).
 */
export function StorageMeter(): ReactNode {
  const volume = useLive(hostFsVolumeInfo, { path: "/" });
  switch (volume.status) {
    case "loading":
    case "error":
    case "unavailable":
      return null;
    case "ready":
      break;
  }
  const { name, total, free } = volume.data;
  const used = Math.max(0, total - free);
  const fraction = total > 0 ? used / total : 0;
  return (
    // A compact region: its captions take the small rung (`2xs`).
    <ControlSizeProvider size="xs">
      <Stack gap="none" className="pt-sm pb-lg" style={METER_INSET}>
        <Text variant="caption" tone="faint">
          {name}
        </Text>
        <div className="py-xs">
          <Clip
            role="meter"
            aria-label={`${name} storage used`}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={used}
            className="h-1 rounded-full bg-input"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${(fraction * 100).toFixed(1)}%` }}
            />
          </Clip>
        </div>
        <Text variant="caption" tone="faint">
          {formatSize(free)} free of {formatSize(total)}
        </Text>
      </Stack>
    </ControlSizeProvider>
  );
}
