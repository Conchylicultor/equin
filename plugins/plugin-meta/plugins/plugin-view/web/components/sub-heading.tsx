import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@plugins/primitives/plugins/collapsible/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";

/**
 * Collapsible sub-section heading used within a plugin detail Section:
 * a muted label + `(count)` trigger over left-bordered content. Shared
 * across per-facet render-detail sections (slots, routes, resources, …).
 */
export function SubHeading({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="gap-xs py-2xs text-caption">
        <CollapsibleChevron className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-muted-foreground">{label}</span>
        <span className="text-muted-foreground/50">({count})</span>
      </CollapsibleTrigger>
      <Inset l="xs">
        <CollapsibleContent className="border-l border-border/50 pl-md pt-2xs">
          {children}
        </CollapsibleContent>
      </Inset>
    </Collapsible>
  );
}
