import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";

/**
 * A `.Dispatch` that fell back inside a `<PluginScope>` though a contribution
 * on the page matches its key — one the scope left out without its
 * composition negating it. What used to render as the generic fallback with
 * nothing marking it: the demo's Read / Edit / Bash cards, after a negative
 * cascaded their renderers out of the scope.
 */
export interface ScopedOutDispatchFault {
  /** The dispatch slot's id. */
  slotId: string;
  /** The dispatch key that fell back (`config.key(props)`). */
  key: string;
  /** The plugin whose contribution matches, outside the scope. */
  plugin: string;
  /** The scope's composition id (`usePluginScopeId()`). */
  scope: string;
}

/**
 * Where `.Dispatch` emits {@link ScopedOutDispatchFault}s — once per (slot,
 * key, plugin, scope) per page. slot-render must not import `reports`, so the
 * collector (`reports/scoped-out-dispatch`) drains it.
 */
export const scopedOutDispatchSink = defineReportSink<ScopedOutDispatchFault>();

const emitted = new Set<string>();

/** Emit `fault` unless this page already did. */
export function emitScopedOutDispatch(fault: ScopedOutDispatchFault): void {
  const id = [fault.slotId, fault.key, fault.plugin, fault.scope].join("\0");
  if (emitted.has(id)) return;
  emitted.add(id);
  scopedOutDispatchSink.emit(fault);
}
