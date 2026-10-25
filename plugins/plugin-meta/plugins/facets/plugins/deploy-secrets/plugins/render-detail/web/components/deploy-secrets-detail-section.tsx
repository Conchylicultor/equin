import {
  SectionCount,
  type PluginNode,
} from "@plugins/plugin-meta/plugins/plugin-view/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { DeploySecretsData } from "@plugins/plugin-meta/plugins/facets/plugins/deploy-secrets/core";

// Read `node.facets[id]` directly (as every render host does) rather than
// importing the build-time `facets/core` barrel, which would drag fs into the
// browser bundle. The type-only import from the facet core is erased.
const DEPLOY_SECRETS_FACET_ID = "deploy-secrets";

function declared(node: PluginNode): DeploySecretsData["declared"] {
  const data = node.facets?.[DEPLOY_SECRETS_FACET_ID] as
    DeploySecretsData | undefined;
  return data?.declared ?? [];
}

/** Nothing declared ⇒ the host paints no card at all. */
export function useDeploySecretsAvailable({
  node,
}: {
  node: PluginNode;
}): boolean {
  return declared(node).length > 0;
}

export function DeploySecretsCount({ node }: { node: PluginNode }) {
  const n = declared(node).length;
  if (n === 0) return null;
  return <SectionCount>{n}</SectionCount>;
}

export function DeploySecretsDetailSection({ node }: { node: PluginNode }) {
  return (
    <Stack gap="2xs">
      {declared(node).map((d) => (
        <Text as="p" variant="caption" key={d.key} className="px-xs">
          <code className="font-mono text-foreground">{d.key}</code> —{" "}
          {d.description}
        </Text>
      ))}
    </Stack>
  );
}
