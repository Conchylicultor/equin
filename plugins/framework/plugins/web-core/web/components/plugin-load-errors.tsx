import type { PluginLoadError } from "@plugins/framework/plugins/web-sdk/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";

export function PluginLoadErrors({ errors }: { errors: PluginLoadError[] }) {
  return (
    // Boot-error banner pinned across the top of the viewport. It renders during
    // bootstrap (before the theme/overlay providers mount), so it stays a raw
    // `fixed` viewport banner rather than routing through ViewportOverlay.
    <Text
      as="div"
      variant="caption"
      // eslint-disable-next-line layout/no-adhoc-layout -- fixed viewport boot-error banner; renders before overlay providers exist
      className="fixed top-0 right-0 left-0 z-max bg-destructive px-md py-xs text-destructive-foreground"
    >
      {errors.map((e, i) => (
        <span key={i} className="pr-lg">
          <span className="font-semibold">{e.pluginPath}</span>{" "}
          <span className="opacity-80">
            {e.error instanceof Error ? e.error.message : String(e.error)}
          </span>
        </span>
      ))}
    </Text>
  );
}
