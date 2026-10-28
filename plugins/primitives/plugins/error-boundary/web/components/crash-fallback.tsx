import { useEffect, useRef, useState } from "react";
import { UNSAFE_unsealSlotComponent } from "@plugins/framework/plugins/web-sdk/core";
import { collectLineageMeta } from "@plugins/primitives/plugins/ui-context/web";
import type { UiContextMeta } from "@plugins/primitives/plugins/ui-context/core";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { ErrorBoundary } from "../slots";
import { boundaryReportSink, type BoundaryErrorReport } from "../reporter";

export function CrashFallback({
  report,
  retry,
}: {
  report: BoundaryErrorReport;
  retry: () => void;
}) {
  const actions = ErrorBoundary.Action.useContributions();
  const [context, setContext] = useState<unknown>(null);
  const [uiContext, setUiContext] = useState<UiContextMeta | null>(null);
  const rootRef = useRef<HTMLElement>(null);

  const tag = [report.slot, report.label].filter(Boolean).join(" / ");

  useEffect(() => {
    let cancelled = false;
    // Defer one tick so plugin-side effects (e.g. boundaryReportSink.register)
    // have run if this boundary fired during the very first commit.
    const timer = setTimeout(() => {
      // This is the single collection point for BOTH boundary classes, and the
      // fallback renders in the crashed subtree's exact position — so its own
      // ancestors ARE the crash site. Ancestors-only on purpose: the fallback's
      // `<Line>` below would otherwise name crash-fallback.tsx as the source.
      // A null ref means the fallback isn't mounted, which can't be recovered
      // from here — omit the field rather than throw on the error path.
      const lineage = rootRef.current
        ? collectLineageMeta(rootRef.current, tag || "Plugin")
        : null;
      if (!cancelled) setUiContext(lineage);
      const result = boundaryReportSink.emit({ ...report, uiContext: lineage });
      if (result && typeof (result as Promise<unknown>).then === "function") {
        // eslint-disable-next-line promise-safety/no-bare-catch
        (result as Promise<unknown>)
          .then((r) => {
            if (!cancelled) setContext(r ?? null);
          })
          .catch((err) => {
            // Never throw from the error path — log and swallow.
            console.error("[error-boundary] boundary reporter failed", err);
          });
      } else if (result !== undefined) {
        setContext(result);
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [report, tag]);

  // Actions get the same enriched report the sink did, so a fix-agent prompt
  // built client-side carries the lineage without reading back the persisted row.
  const enriched: BoundaryErrorReport = { ...report, uiContext };
  return (
    // Single-line row: rigid identity → the ONE flexible <Fill> holding the
    // truncating message → rigid trailing actions. <Fill> absorbs the slack
    // (so actions stay flush-right, replacing ml-auto) AND lets the message
    // <Text> ellipsize under pressure — so a long message can never push the
    // Fix/Retry recovery actions off the clickable area. The full message
    // stays available via the native title tooltip. The row sets the caption
    // role on itself so contributed actions (plain buttons) inherit the same
    // size as the words beside them instead of the surface's body size.
    <Line
      ref={rootRef}
      className="gap-sm rounded-md border border-destructive/20 bg-destructive/10 px-md py-sm text-caption text-destructive"
    >
      <Text variant="caption" className="font-medium">
        {tag || "Plugin"} crashed
      </Text>
      <Fill>
        <Text
          variant="caption"
          className="text-destructive/70"
          title={report.error.message}
        >
          {report.error.message}
        </Text>
      </Fill>
      {actions.map((action, i) => {
        // UNSAFE: rendered inside the boundary's own fallback — wrapping again is circular.
        const Component = UNSAFE_unsealSlotComponent(action.component);
        return <Component key={i} report={enriched} context={context} />;
      })}
      <Text
        as="button"
        variant="caption"
        // A rigid action, not a truncating leaf: only the message <Fill> yields.
        className={cn(rigidClass(), "underline hover:no-underline")}
        onClick={retry}
      >
        Retry
      </Text>
    </Line>
  );
}
