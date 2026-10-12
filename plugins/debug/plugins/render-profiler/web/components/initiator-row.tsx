import {
  Stack,
  Inset,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Badge,
  type BadgeVariant,
} from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import type { HookChange, HookKind, InitiatorStat } from "../../core";

const HOOK_LABEL: Record<HookKind, string> = {
  state: "useState/useReducer",
  reducer: "useReducer",
  "external-store": "useSyncExternalStore",
  effect: "effect",
  "layout-effect": "layout effect",
  memo: "useMemo",
  callback: "useCallback",
  ref: "useRef",
  context: "context",
  unknown: "hook",
};

// external-store (the live-state/useQuery culprit) stands out; context is info.
function hookVariant(kind: HookKind): BadgeVariant {
  if (kind === "external-store") return "warning";
  if (kind === "context") return "info";
  return "muted";
}

function HookBadge({ change }: { change: HookChange }) {
  return (
    <Badge variant={hookVariant(change.kind)}>
      {HOOK_LABEL[change.kind]} #{change.index}
    </Badge>
  );
}

export function InitiatorRow({ stat }: { stat: InitiatorStat }) {
  return (
    <Inset x="md" y="sm" as="li">
      <Stack gap="2xs">
        <Text as="div" variant="label">
          {stat.componentName}
        </Text>
        {stat.ancestorPath.length > 0 && (
          <Text as="div" variant="caption" tone="muted">
            {stat.ancestorPath.join(" › ")}
          </Text>
        )}
        <Text as="div" variant="caption" tone="muted">
          {stat.commitCount} commits · {stat.ratePerSec.toFixed(1)}/s
          {stat.instanceCount > 1 ? ` · ×${stat.instanceCount} instances` : ""}
        </Text>
        <Text as="div" variant="caption" tone="muted">
          {stat.mountCount} mounts · {stat.updateCount} updates ·{" "}
          {stat.fibersRendered} fibers rendered
        </Text>
        {stat.changedHooks.length > 0 && (
          <Cluster>
            {stat.changedHooks.map((h) => (
              <HookBadge key={`${h.kind}-${h.index}`} change={h} />
            ))}
          </Cluster>
        )}
      </Stack>
    </Inset>
  );
}
