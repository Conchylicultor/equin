import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import type { ReactNode } from "react";
import { appLink } from "@plugins/apps-core/plugins/tabs/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { LinkChip } from "@plugins/primitives/plugins/css/plugins/link-chip/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { useManifestItemByName } from "@plugins/plugin-meta/plugins/composition/web";
import type { CompositionManifestItem } from "@plugins/plugin-meta/plugins/composition/core";
import { studioApp } from "@plugins/apps/plugins/studio/plugins/shell/core";
import { compositionDetailRoute } from "@plugins/apps/plugins/studio/plugins/compositions/core";
import { deployments } from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const layersIcon = symbol("layers");

/**
 * **Composition** — *what* this deployment builds and ships, and where that is
 * edited.
 *
 * Every other section of this pane answers a question about the *placement*: at
 * which URL, on which box, from which bundle, on which run. The software itself
 * was named only by the pane's tab title and implied by the derived install
 * paths, so the one thing a deploy is *of* was the one thing the surface never
 * said out loud.
 *
 * It stays a **reference**, not an editor: `compositionId` is create-only on the
 * row precisely because re-pointing a converged install at different software is
 * not an edit, and the composition's own membership lives in the `compositions`
 * config, which Studio owns. So this section names the composition, states
 * enough of its shape to recognise it, and hands off.
 */
export function CompositionSection({
  deploymentId,
}: {
  deploymentId: string;
}): ReactNode {
  const deployment = useLiveRow(deployments, deploymentId);

  if (deployment.status === "loading") return <Loading variant="rows" />;
  if (deployment.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the deployment"
        error={deployment.error}
        refetch={deployment.refetch}
      />
    );
  }
  if (!deployment.found) {
    return (
      <Placeholder tone="error">This deployment no longer exists.</Placeholder>
    );
  }
  return <CompositionRef name={deployment.row.compositionId} />;
}

/**
 * The row stores a composition **name**; Studio's pane is keyed by the config
 * item's uuid — so the link exists only once the name resolves to a live item.
 * A name that no longer resolves is a real state (the row's name is validated
 * when written, and nothing stops a later rename or delete), and it is rendered
 * as itself rather than as a dead chip: what deploy would ask `release` to build
 * is exactly this string, and no such composition answers to it.
 */
function CompositionRef({ name }: { name: string }): ReactNode {
  const item = useManifestItemByName(name);

  if (!item) {
    return (
      <Placeholder tone="error">
        No composition named “{name}” in the compositions config. This
        deployment was created against a name that has since been renamed or
        removed, so there is nothing to build — recreate the deployment against
        a live composition.
      </Placeholder>
    );
  }
  return <CompositionCard item={item} />;
}

function CompositionCard({
  item,
}: {
  item: CompositionManifestItem;
}): ReactNode {
  return (
    <Stack gap="md">
      <Stack gap="2xs">
        <Cluster gap="xs">
          <LinkChip
            mono
            leading={<Icon icon={layersIcon} />}
            tooltip={`Open “${item.name}” in Studio`}
            activation={appLink(
              compositionDetailRoute.link(studioApp, { id: item.id }),
            )}
          >
            {item.name}
          </LinkChip>
          <Badge variant="muted">{item.category}</Badge>
        </Cluster>
        <Text as="p" variant="caption" tone="muted">
          The plugin closure this deployment builds and ships. What is in it —
          entry points, opted-in contributors, what it extends — is edited in
          Studio; the deployment only says where it is served.
        </Text>
      </Stack>

      <Stack gap="2xs">
        <Text as="span" variant="label">
          Entry points
        </Text>
        {item.entryPoints.length > 0 ? (
          <Cluster gap="xs">
            {item.entryPoints.map((id) => (
              <Badge key={id} variant="muted" mono>
                {id}
              </Badge>
            ))}
          </Cluster>
        ) : (
          <Text as="p" variant="caption" tone="muted">
            None — the closure has no roots, so this composition bundles only
            what its contributors and packs bring in.
          </Text>
        )}
      </Stack>

      {item.extends.length > 0 && (
        <Stack gap="2xs">
          <Text as="span" variant="label">
            Extends
          </Text>
          <Cluster gap="xs">
            {item.extends.map((base) => (
              <Badge key={base} variant="muted" mono>
                {base}
              </Badge>
            ))}
          </Cluster>
        </Stack>
      )}

      <Text as="p" variant="caption" tone="muted">
        {item.selectedContributors.length} contributor{" "}
        {item.selectedContributors.length === 1 ? "plugin" : "plugins"} opted in
        on top of that closure. Nothing soft is included by default.
      </Text>
    </Stack>
  );
}
