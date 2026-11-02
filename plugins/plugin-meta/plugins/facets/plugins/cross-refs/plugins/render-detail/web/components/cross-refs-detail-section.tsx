import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useState } from "react";
import {
  SectionCount,
  SubHeading,
  PluginLink,
  RUNTIME_COLORS,
  type PluginNode,
  type ExportRuntime,
} from "@plugins/plugin-meta/plugins/plugin-view/web";
import {
  RUNTIME_FOLDERS,
  asPath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type {
  CrossRefsData,
  ApiUse,
} from "@plugins/plugin-meta/plugins/facets/plugins/cross-refs/core";

// Renders the cross-refs facet's own data. Read `node.facets[id]` directly (as
// every render host does) rather than importing the build-time `facets/core`
// barrel, which would drag `loadFacets` + `fs`/`path` into the browser bundle.
// The type-only import from the facet core is erased and safe.
const CROSS_REFS_FACET_ID = "cross-refs";

const RUNTIMES = RUNTIME_FOLDERS;

function countUses(data: CrossRefsData): number {
  return RUNTIMES.reduce((sum, rt) => sum + data.apiUses[rt].length, 0);
}

/** This plugin's cross-plugin edges, or `null` when it has none in either direction. */
function crossRefs(node: PluginNode): CrossRefsData | null {
  const data = node.facets?.[CROSS_REFS_FACET_ID] as CrossRefsData | undefined;
  if (!data) return null;
  if (countUses(data) === 0 && data.importedBy.length === 0) return null;
  return data;
}

/** No uses and no importers ⇒ the host paints no card at all. */
export function useCrossRefsAvailable({ node }: { node: PluginNode }): boolean {
  return crossRefs(node) !== null;
}

export function CrossRefsCount({ node }: { node: PluginNode }) {
  const data = crossRefs(node);
  if (!data) return null;
  const totalUses = countUses(data);
  const parts: string[] = [];
  if (totalUses > 0)
    parts.push(`${totalUses} use${totalUses !== 1 ? "s" : ""}`);
  if (data.importedBy.length > 0)
    parts.push(
      `${data.importedBy.length} importer${data.importedBy.length !== 1 ? "s" : ""}`,
    );
  return <SectionCount>{parts.join(" · ")}</SectionCount>;
}

export function CrossRefsDetailSection({ node }: { node: PluginNode }) {
  const data = crossRefs(node);
  if (!data) return null;

  const { apiUses, importedBy } = data;
  const totalUses = countUses(data);

  return (
    <Stack gap="md">
      {importedBy.length > 0 && <ImportedByBanner names={importedBy} />}
      {totalUses > 0 && (
        <SubHeading label="Uses" count={totalUses}>
          <Stack gap="sm">
            {RUNTIMES.map((rt) =>
              apiUses[rt].length > 0 ? (
                <UsesGroup key={rt} runtime={rt} uses={apiUses[rt]} />
              ) : null,
            )}
          </Stack>
        </SubHeading>
      )}
    </Stack>
  );
}

// ── Per-runtime uses group ──────────────────────────────────────────

function UsesGroup({
  runtime,
  uses,
}: {
  runtime: ExportRuntime;
  uses: ApiUse[];
}) {
  return (
    <Stack gap="2xs">
      <Stack direction="row" gap="xs" className="text-caption px-sm">
        <span className={cn("font-mono font-medium", RUNTIME_COLORS[runtime])}>
          {runtime}
        </span>
        <span className="text-muted-foreground/50">({uses.length})</span>
      </Stack>
      <Inset l="xs">
        <Stack gap="none" className="gap-px border-l border-border/50 pl-md">
          {uses.map((u) => (
            <Text
              as="code"
              variant="caption"
              key={`${u.plugin}:${u.symbol ?? ""}`}
              className="truncate px-xs py-px font-mono text-foreground"
            >
              {asPath(u.plugin)}
              {u.symbol ? "." + u.symbol : ""}
            </Text>
          ))}
        </Stack>
      </Inset>
    </Stack>
  );
}

// ── Imported-by banner (ported from public-api-section.tsx) ──────────

function ImportedByBanner({ names }: { names: PluginId[] }) {
  const [expanded, setExpanded] = useState(false);
  const threshold = 4;
  const visible = expanded ? names : names.slice(0, threshold);
  const remaining = names.length - threshold;

  return (
    <Cluster gap="xs" className="gap-y-2xs text-3xs text-muted-foreground">
      <span className="font-medium">Imported by</span>
      {visible.map((name, i) => (
        <Inline gap="none" key={name}>
          <PluginLink name={name} label={asPath(name)} />
          {i < visible.length - 1 && (
            <span className="text-muted-foreground/40">,</span>
          )}
        </Inline>
      ))}
      {!expanded && remaining > 0 && (
        <button
          className="text-muted-foreground/60 hover:text-foreground"
          onClick={() => setExpanded(true)}
        >
          +{remaining} more
        </button>
      )}
    </Cluster>
  );
}
