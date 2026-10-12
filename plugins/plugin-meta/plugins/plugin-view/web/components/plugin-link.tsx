import { useOpenPane } from "@plugins/primitives/plugins/pane/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { pluginViewPane } from "../panes";

/**
 * Inline button linking to another plugin's detail pane. Shared across the
 * per-facet render-detail sections (exports, cross-refs, …) that surface
 * consumer/importer relationships.
 */
export function PluginLink({
  name,
  label,
  className = "font-medium text-muted-foreground hover:text-foreground hover:underline",
}: {
  name: string;
  label?: string;
  className?: string;
}) {
  const openPane = useOpenPane();
  return (
    <button
      className={className}
      // Isolated: the link sits inside rows that are clickable themselves.
      {...activationProps(
        openPane.to(pluginViewPane, { pluginId: name }, { mode: "swap" }),
        { isolate: true },
      )}
    >
      {label ?? name}
    </button>
  );
}
