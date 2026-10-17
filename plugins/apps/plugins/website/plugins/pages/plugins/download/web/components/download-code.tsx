import { CopyButton } from "@plugins/primitives/plugins/copy-to-clipboard/web";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { track } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";

/**
 * Something the reader copies whole — a shell command or a prompt — in a flat
 * panel with one copy button beside it.
 *
 * A `command` is monospaced, on one line that scrolls sideways rather than
 * wraps (a wrapped command reads as two), behind a `$` the copy leaves out. A
 * `prompt` is prose, so it wraps in the body face.
 *
 * Each copy is recorded as a `download_copy_<kind>` analytics event.
 */
export function DownloadCode({
  kind,
  text,
}: {
  kind: "command" | "prompt";
  text: string;
}) {
  return (
    <Card className="rounded-xl shadow-none">
      {/* A command is one line: centre it on the copy button so the card's
          space above and below the line match. A prompt wraps, so its first
          line stays level with the button's top. */}
      <Stack
        direction="row"
        gap="md"
        align={kind === "command" ? "center" : "start"}
      >
        <Fill>
          {kind === "command" ? (
            <Scroll axis="x">
              <Text as="pre" variant="code" className="whitespace-pre">
                <span aria-hidden className="text-muted-foreground select-none">
                  ${" "}
                </span>
                {text}
              </Text>
            </Scroll>
          ) : (
            <Text
              as="pre"
              variant="body"
              tone="muted"
              className="font-sans whitespace-pre-wrap"
            >
              {text}
            </Text>
          )}
        </Fill>
        <CopyButton
          text={text}
          tooltip="Copy"
          className="border-border border"
          onClick={() => track(`download_copy_${kind}`)}
        />
      </Stack>
    </Card>
  );
}
