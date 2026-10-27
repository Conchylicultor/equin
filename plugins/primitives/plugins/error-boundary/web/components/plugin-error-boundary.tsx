import { Component, type ErrorInfo, type ReactNode } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import { CrashFallback } from "./crash-fallback";

interface State {
  error: Error | null;
  componentStack: string | null;
}

/** What a crash report names as the crashed thing's place. */
interface Origin {
  slot: string | null;
  label: string | null;
}

/**
 * The one boundary: catch, render the `CrashFallback` (reporting + retry), and
 * let each subclass say only where it sits. A class per call shape rather than
 * a wrapper component per call shape, so a boundary is ONE fiber wherever it is.
 */
abstract class CrashBoundary<
  P extends { children: ReactNode },
> extends Component<P, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  protected abstract origin(): Origin;

  componentDidCatch(_error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private retry = () => {
    this.setState({ error: null, componentStack: null });
  };

  render() {
    if (this.state.error) {
      return (
        <CrashFallback
          report={{
            error: this.state.error,
            componentStack: this.state.componentStack,
            ...this.origin(),
          }}
          retry={this.retry}
        />
      );
    }
    return this.props.children;
  }
}

interface Props {
  slot?: string;
  label?: string;
  children: ReactNode;
}

export class PluginErrorBoundary extends CrashBoundary<Props> {
  protected origin(): Origin {
    return { slot: this.props.slot ?? null, label: this.props.label ?? null };
  }
}

/**
 * The boundary around every slot contribution, contributed to slot-render as
 * its item middleware directly — the class IS the middleware, so isolating a
 * contribution costs one fiber.
 */
export class SlotItemErrorBoundary extends CrashBoundary<{
  slotId: string;
  contribution: Contribution;
  children: ReactNode;
}> {
  protected origin(): Origin {
    return {
      slot: this.props.slotId,
      label: this.props.contribution._pluginId ?? null,
    };
  }
}
