import { useEffect } from "react";
import { RENDER_PROFILER_GLOBAL } from "../../core";
import type { RenderProfilerWindow } from "../../core";
import type { Fiber } from "./react-types";
import { isComponentFiber } from "./fiber-walk";
import { startSession, stopSession, getReport, isRunning } from "./session";

// Components whose churn must never be attributed (the profiler's own pane UI),
// keyed by component reference (function/class). Mirrors the DOM detector
// excluding the toaster/picker.
const excludedComponents = new Set<unknown>();

/** Register a component (by reference) so the profiler ignores its renders. */
export function registerExcludedComponent(fn: unknown): void {
  excludedComponents.add(fn);
}

function fiberTypeRef(fiber: Fiber): unknown {
  const type = fiber.type;
  // Unwrap forwardRef/memo to the underlying render fn for a stable identity.
  if (type && typeof type === "object") {
    return type.render ?? type.type ?? type;
  }
  return type;
}

/**
 * True when the initiator OR any of its component ancestors is excluded — so a
 * child rendered inside the profiler pane is dropped too.
 */
export function isExcludedFiber(fiber: Fiber): boolean {
  let node: Fiber | null = fiber;
  while (node) {
    if (isComponentFiber(node) && excludedComponents.has(fiberTypeRef(node))) {
      return true;
    }
    node = node.return;
  }
  return false;
}

let installed = false;

/** Install the window-level imperative API. Idempotent. */
export function installGlobalApi(): void {
  if (installed) return;
  installed = true;
  (window as RenderProfilerWindow)[RENDER_PROFILER_GLOBAL] = {
    start: (opts) => startSession(opts),
    stop: () => stopSession(),
    getReport: () => getReport(),
    isRunning: () => isRunning(),
  };
}

/** Invisible component mounted via Core.Root to install the global API once. */
export function ProfilerInstaller(): null {
  useEffect(() => {
    installGlobalApi();
  }, []);
  return null;
}
