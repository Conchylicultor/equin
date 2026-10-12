import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { MapClusterProps } from "../slots";

/**
 * The cluster of a type nobody claimed (or of mixed types): a disc in the
 * default pin's paint holding the count. Plain on purpose — a type's owner
 * contributes its real look through `GeoMap.Cluster`.
 */
export function DefaultCluster({ count }: MapClusterProps) {
  return (
    <Center
      as="span"
      role="img"
      aria-label={`${count} pins`}
      className="h-7 min-w-7 rounded-full border-2 border-background bg-primary px-xs text-primary-foreground shadow-md"
    >
      <Text variant="count">{count}</Text>
    </Center>
  );
}
