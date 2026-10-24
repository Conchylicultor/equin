import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Stack,
  insetClass,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useStatusLine } from "../internal/panel-status";

/**
 * The panel's header: the equin spiral (the app icon, `web-core/public/icon.svg`)
 * and one status line joined from every `MenuBar.Status` part.
 */
export function PanelHeader() {
  const line = useStatusLine();
  return (
    <Stack
      direction="row"
      gap="lg"
      align="center"
      className={insetClass({ x: "md", t: "md", b: "lg" })}
    >
      <img src="/icon.svg" alt="" className={cn("size-7.5", rigidClass())} />
      <Fill>
        <Stack gap="none">
          <Text as="div" variant="label" className="font-semibold">
            equin
          </Text>
          {line.kind === "pending" ? (
            <Loading variant="block" className="h-3 w-40" />
          ) : (
            <Text as="div" variant="caption" tone="muted">
              {line.text ?? "All quiet"}
            </Text>
          )}
        </Stack>
      </Fill>
    </Stack>
  );
}
