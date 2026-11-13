import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";

/** Fallback rendered by `SonataPlayer.Display.Dispatch` when no display matches. */
export function NoDisplay() {
  return (
    <Center axis="both" className="h-full">
      <Text as="div" variant="body" className="text-muted-foreground">
        No display selected.
      </Text>
    </Center>
  );
}
