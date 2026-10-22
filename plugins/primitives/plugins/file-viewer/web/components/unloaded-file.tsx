import type { AssetSrc } from "@plugins/infra/plugins/endpoints/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";

/**
 * A renderer's body while its file's bytes are not loadable (`useAssetSrc` on
 * `fileUrl(file)` answered anything but `ready`): the loading state while they
 * are fetched, the reason when the host cannot serve them or the fetch failed.
 */
export function UnloadedFile({
  src,
}: {
  src: Exclude<AssetSrc, { kind: "ready" }>;
}) {
  if (src.kind === "loading") return <Loading variant="spinner" />;
  return (
    <Center axis="both" className="h-full p-lg">
      <Text as="p" variant="body" tone="muted">
        {src.message}
      </Text>
    </Center>
  );
}
