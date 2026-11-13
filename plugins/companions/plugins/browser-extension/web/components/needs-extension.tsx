import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Logo } from "@plugins/ui/plugins/logo/web";

/** The route opened outside the extension: there is no tab to act on. */
export function NeedsExtension() {
  return (
    <Surface
      level="overlay"
      className="size-full rounded-none shadow-none ring-0"
    >
      <Center className="size-full">
        <Stack gap="xs" align="center" className="max-w-80 text-center">
          <Logo className="size-10 opacity-50" />
          <Text as="div" variant="label" className="font-semibold">
            This page runs inside the equin browser extension
          </Text>
          <Text as="div" variant="caption" tone="muted">
            Install it from Settings → Accounts → Browser extension, then open
            it from Chrome&rsquo;s toolbar.
          </Text>
        </Stack>
      </Center>
    </Surface>
  );
}
