import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { TextDiff } from "@plugins/primitives/plugins/diff-view/web";
import { configRawFile } from "@plugins/config_v2/core";

// Side-by-side diff for an *invalid* conflict: the stored override document that
// is currently in effect (left) vs the schema defaults (right). The invalid data
// can live in any layer — a user override, or (more often) a git override that
// propagated into the user origin — so the "stored" side falls back through the
// layers. The defaults side is the git origin (the generated baseline).
export function InvalidDiff({
  storePath,
  scopeId,
}: {
  storePath: string;
  scopeId: string | undefined;
}) {
  const raw = useLive(configRawFile, { path: storePath, scopeId });

  if (raw.status === "loading") return <Loading label="Loading diff…" />;
  if (raw.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the raw files"
        error={raw.error}
        refetch={raw.refetch}
      />
    );
  }
  const data = raw.data;

  const stored = data.override ?? data.gitOverride ?? data.origin ?? "";
  const defaults = data.gitOrigin ?? data.origin ?? "";

  return (
    // eslint-disable-next-line spacing/no-adhoc-spacing -- mb-2 separates the diff block from the following content
    <Clip className="mb-2 rounded-md border border-border">
      <Text
        as="div"
        variant="caption"
        tone="muted"
        className="border-b border-border bg-muted/40 px-md py-xs font-medium"
      >
        <Stack direction="row" align="center" justify="between" gap="none">
          <span>Stored (invalid)</span>
          <span>Defaults</span>
        </Stack>
      </Text>
      <Scroll axis="both" className="max-h-96">
        {stored === defaults ? (
          <Placeholder>No differences in the raw files.</Placeholder>
        ) : (
          <TextDiff oldText={stored} newText={defaults} path="config.json" />
        )}
      </Scroll>
    </Clip>
  );
}
