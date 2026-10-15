import type { ReactElement } from "react";
import { useRawContributions } from "@plugins/framework/plugins/web-sdk/core";
import { Apps, type AppEntry } from "@plugins/apps-core/web";
import type { MembershipState } from "@plugins/plugin-meta/plugins/closure/core";
import {
  useActiveMembership,
  useManifestActions,
  useManifestItems,
} from "@plugins/plugin-meta/plugins/composition/web";
import { isCommittedSourceComposition } from "@plugins/plugin-meta/plugins/composition/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/** The membership states that put a plugin in the bundle. */
const BUNDLED = new Set<MembershipState>([
  "entry",
  "required",
  "contributor",
  "via-contributor",
]);

const NONE = "";

/**
 * The composition's `home` — the app that owns bare `/` (and the app launcher's
 * click) once it is deployed. The choices are the apps whose shell is in the
 * active composition's bundle: every `Apps.App` registered here, kept when its
 * contributing plugin is bundled. `composition-closure` and codegen re-check the
 * stored value against the committed bundle, so this list is a convenience, not
 * the guarantee.
 */
export function HomeSection({ id }: { id: string }): ReactElement {
  const item = useManifestItems().find((it) => it.id === id);
  const membership = useActiveMembership();
  const { setHome } = useManifestActions();
  const apps = useRawContributions(Apps.App);

  if (!item || !membership) {
    return (
      <Text variant="caption" tone="muted">
        No active composition.
      </Text>
    );
  }

  const bundled = apps
    .filter((c) => {
      const state =
        c._pluginId === undefined ? undefined : membership.get(c._pluginId);
      return state !== undefined && BUNDLED.has(state);
    })
    .map((c) => (c as unknown as AppEntry).app);
  const options = [
    { value: NONE, label: "None" },
    ...bundled.map((a) => ({ value: a.id, label: `${a.name} (${a.id})` })),
  ];
  // A stored home outside the current bundle stays visible (and flagged) rather
  // than reading as "None" — the check will name it too.
  const stray = item.home !== NONE && !bundled.some((a) => a.id === item.home);
  if (stray)
    options.push({ value: item.home, label: `${item.home} (not bundled)` });
  const items = Object.fromEntries(options.map((o) => [o.value, o.label]));
  const readOnly = isCommittedSourceComposition(id);

  return (
    <Stack gap="xs">
      <Select
        items={items}
        value={item.home}
        disabled={readOnly}
        onValueChange={(v: string | null) => setHome(id, v ?? NONE)}
      >
        <SelectTrigger aria-label="Home app" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Text variant="caption" tone="muted">
        {readOnly
          ? "Committed in plugins/plugin-meta/plugins/composition/core/config.ts."
          : stray
            ? "This app is not in the bundle — composition-closure will refuse it."
            : "Where bare / lands when this composition is deployed."}
      </Text>
    </Stack>
  );
}
