import { useMemo } from "react";
import {
  useExpandAll,
  ExpandAllButton,
} from "@plugins/primitives/plugins/collapsible/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import type { PluginChangesResult } from "../use-plugin-changes";
import { PluginChangeCard } from "./plugin-change-card";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";

export function PluginChangesList({
  conversationId,
  data,
  isPending,
  error,
}: PluginChangesResult & { conversationId: string }) {
  const allPaths = useMemo(
    () => data?.plugins.map((p) => p.path) ?? [],
    [data],
  );

  const {
    expanded: expandedSet,
    allExpanded,
    toggleAll,
    toggle,
  } = useExpandAll(allPaths);

  if (isPending) {
    return <Loading label="Loading plugins…" />;
  }
  if (error) {
    return <Placeholder tone="error">Error: {String(error)}</Placeholder>;
  }
  if (!data) {
    return <Loading label="Loading plugins…" />;
  }
  if (data.plugins.length === 0) {
    return <Placeholder>No plugin API changes detected.</Placeholder>;
  }

  return (
    <Stack gap="sm">
      <Stack direction="row" gap="none" justify="end">
        <ExpandAllButton
          variant="full"
          allExpanded={allExpanded}
          onToggle={toggleAll}
        />
      </Stack>
      {data.plugins.map((plugin) => (
        <PluginChangeCard
          key={plugin.path}
          conversationId={conversationId}
          plugin={plugin}
          expanded={expandedSet.has(plugin.path)}
          onToggle={() => toggle(plugin.path)}
        />
      ))}
    </Stack>
  );
}
