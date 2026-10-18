import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import {
  RUNTIME_COLORS,
  type PluginNode,
} from "@plugins/plugin-meta/plugins/plugin-view/web";

/**
 * At most four pills — one line, so they ride the section header as `summary`
 * rather than sitting behind a chevron.
 */
export function RuntimesSummary({ node }: { node: PluginNode }) {
  return (
    <Inline gap="xs">
      {node.runtimes.web && <RuntimePill kind="web" />}
      {node.runtimes.server && <RuntimePill kind="server" />}
      {node.runtimes.machine && <RuntimePill kind="machine" />}
      {node.runtimes.central && <RuntimePill kind="central" />}
    </Inline>
  );
}

function RuntimePill({
  kind,
}: {
  kind: "web" | "server" | "machine" | "central";
}) {
  return <Badge colorClass={RUNTIME_COLORS[kind]}>{kind}</Badge>;
}
