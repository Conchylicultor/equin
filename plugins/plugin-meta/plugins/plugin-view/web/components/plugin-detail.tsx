import { pluginIdSegments } from "@plugins/framework/plugins/plugin-id/core";
import { Breadcrumb } from "@plugins/primitives/plugins/breadcrumb/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import type { PluginNode } from "../../core";
import { PluginView } from "../slots";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";

const boltIcon = symbol("bolt");

interface PluginDetailProps {
  node: PluginNode | null;
}

export function PluginDetail({ node }: PluginDetailProps) {
  if (!node) {
    return (
      <Center axis="both" className="h-full text-center">
        <div className="max-w-sm">
          <Placeholder>
            Select a plugin to inspect what would be included in its release.
          </Placeholder>
        </div>
      </Center>
    );
  }

  const trail = pluginIdSegments(node.id);

  return (
    <Scroll className="h-full">
      <div className="mx-auto max-w-3xl">
        <Stack as="header" gap="md" className="px-xl pt-xl">
          <Text as="div" variant="title" className="tracking-tight">
            <Stack direction="row" align="baseline" gap="md">
              <Breadcrumb
                segments={trail.map((seg, i) => ({
                  key: String(i),
                  label: seg,
                }))}
                actions={
                  node.loadBearing ? (
                    <Badge variant="warning" icon={<Icon icon={boltIcon} />}>
                      Load-bearing
                    </Badge>
                  ) : undefined
                }
              />
            </Stack>
          </Text>
          {node.description && (
            <Text
              as="p"
              variant="body"
              className="max-w-prose text-muted-foreground"
            >
              {node.description}
            </Text>
          )}
        </Stack>

        <PluginView.Host node={node} />
      </div>
    </Scroll>
  );
}
