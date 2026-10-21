import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import type { Activation } from "@plugins/primitives/plugins/link-gesture/core";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";

export function FileDisambiguation({
  query,
  matches,
  total,
  activationFor,
}: {
  query: string;
  /** The best candidates, in order — possibly a capped prefix of them all. */
  matches: string[];
  /** How many files matched in all; more than `matches` holds when capped. */
  total: number;
  /**
   * What picking a candidate does — a `LinkTarget` when it opens the file, so
   * ⌘/middle-click opens it in a new browser tab.
   */
  activationFor: (path: string) => Activation;
}) {
  return (
    <Stack gap="xs" className="h-full p-md">
      {/* eslint-disable-next-line spacing/no-adhoc-spacing -- bottom offset on heading above the scroll region, larger than the flex gap */}
      <Text as="div" variant="caption" className="mb-1 text-muted-foreground">
        Multiple files match{" "}
        <span className="font-mono font-medium text-foreground">{query}</span>
        {total > matches.length &&
          ` — the best ${matches.length} of ${total} shown`}
      </Text>
      <Scroll axis="both" fill>
        {/* eslint-disable-next-line data-view/no-adhoc-row-list -- ambiguous-path candidate picker (transient chrome) */}
        {matches.map((filePath) => {
          const lastSlash = filePath.lastIndexOf("/");
          const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : "";
          const name =
            lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
          return (
            <Row
              key={filePath}
              size="sm"
              {...activationProps(activationFor(filePath))}
            >
              <span className="text-muted-foreground">{dir}</span>
              <span className="font-medium text-foreground">{name}</span>
            </Row>
          );
        })}
      </Scroll>
    </Stack>
  );
}
