import type { ReactNode } from "react";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { PickSource } from "@plugins/apps/plugins/places/plugins/ask/core";

/**
 * Where Sonnet read about a pick, as small links opening in a new tab — "Le
 * Fooding · Time Out". A source's title is the agent's wording; its address
 * is shown as the link's tooltip.
 */
export function PickSources({
  sources,
}: {
  sources: readonly PickSource[];
}): ReactNode {
  return (
    <Cluster gap="2xs" align="center">
      {sources.map((s, i) => (
        <Text key={s.url} variant="caption" tone="muted">
          {i > 0 ? "· " : null}
          <a
            href={s.url}
            target="_blank"
            rel="noreferrer"
            title={s.url}
            className="text-primary-text hover:underline"
          >
            {s.title}
          </a>
        </Text>
      ))}
    </Cluster>
  );
}
