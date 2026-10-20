import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

/**
 * The one way a preview says its source does not render: the renderer's own
 * message, in the destructive tone, where the preview would be. Shared so every
 * language fails the same way — never a blank box that reads as "empty diagram".
 */
export function CodePreviewError({
  label,
  message,
}: {
  /** The language's name ("Mermaid"). */
  label: string;
  message: string;
}) {
  return (
    <Stack gap="xs" className="px-md py-sm" role="alert">
      <Text variant="caption" tone="destructive">
        {label} didn&apos;t render
      </Text>
      <Text
        as="pre"
        variant="code"
        tone="muted"
        className="whitespace-pre-wrap"
      >
        {message}
      </Text>
    </Stack>
  );
}
