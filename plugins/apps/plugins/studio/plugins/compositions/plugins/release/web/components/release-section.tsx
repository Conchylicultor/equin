import { useState, type ReactElement } from "react";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ToggleChip } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { useManifestItems } from "@plugins/plugin-meta/plugins/composition/web";
import { RELEASE_TARGETS, triggerReleaseEndpoint } from "@plugins/release/core";
import {
  ServeTargetPanel,
  useServeStatus,
} from "@plugins/build/plugins/serve-composition/web";
import type { CompositionManifestItem } from "@plugins/plugin-meta/plugins/composition/core";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const boltIcon = symbol("bolt");
const languageIcon = symbol("language");
const playArrowIcon = symbol("play-arrow");

// The "Serve live" pseudo-target. Deliberately NOT in RELEASE_TARGETS — that core
// list drives real release build-args + the server validator; "serve" is a
// UI-only target that routes to the serve capability, not a release build.
const SERVE_TARGET = { id: "serve", label: "Serve live", implemented: true };
const PICKER_TARGETS = [SERVE_TARGET, ...RELEASE_TARGETS];

// Web-only icon decoration for the target list (the engine carries no icon —
// the server must not import a UI component, so the web attaches a glyph by id).
const TARGET_ICONS: Record<string, IconRef> = {
  serve: boltIcon,
  web: languageIcon,
};

function TargetPicker({
  target,
  onPick,
}: {
  target: string | null;
  onPick: (id: string) => void;
}): ReactElement {
  return (
    <Cluster gap="sm">
      {PICKER_TARGETS.map((t) => {
        const icon = TARGET_ICONS[t.id];
        return (
          <ToggleChip
            key={t.id}
            active={target === t.id}
            disabled={!t.implemented}
            icon={icon ? <Icon icon={icon} /> : undefined}
            onClick={() => onPick(t.id)}
            tooltip={t.implemented ? t.label : `${t.label} (coming soon)`}
          >
            {t.implemented ? t.label : `${t.label} (soon)`}
          </ToggleChip>
        );
      })}
    </Cluster>
  );
}

export function ReleaseSection({ id }: { id: string }): ReactElement {
  const item = useManifestItems().find((it) => it.id === id);
  const [target, setTarget] = useState<string | null>("serve");
  const trigger = useEndpointMutation(triggerReleaseEndpoint);

  const name = item?.name;
  // Only apps are releasable — the other categories (profile / subsystem / pack)
  // are inspection lenses with no product to build. Serving, however, is
  // available for ALL categories.
  const releasable = item?.category === "app";
  const canRun =
    name !== undefined && releasable && target !== null && !trigger.isPending;

  return (
    <Stack gap="sm">
      <Stack gap="2xs">
        <Text as="span" variant="label" className="text-muted-foreground">
          Target
        </Text>
        <TargetPicker target={target} onPick={setTarget} />
      </Stack>

      {target === "serve" ? (
        item ? (
          <ServeTarget item={item} />
        ) : null
      ) : (
        <>
          <Button
            variant="default"
            loading={trigger.isPending}
            disabled={!canRun}
            onClick={() => {
              if (name && target)
                trigger.mutate({ body: { composition: name, target } });
            }}
          >
            <Icon icon={playArrowIcon} className="size-4" />
            Run release
          </Button>

          {item && !releasable && (
            <Text as="p" variant="caption" className="text-muted-foreground">
              Only <code>app</code> compositions are releasable — this one is a{" "}
              <code>{item.category}</code>.
            </Text>
          )}
        </>
      )}
    </Stack>
  );
}

/**
 * The Serve live target. A component of its own so the liveness read is asked
 * for a composition that exists — the panel is only ever rendered with a real
 * manifest item, and a hook cannot be called conditionally.
 */
function ServeTarget({
  item,
}: {
  item: CompositionManifestItem;
}): ReactElement {
  const status = useServeStatus(item.id);
  return <ServeTargetPanel item={item} status={status} />;
}
