import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";

/** One event of a folded context run, with its index in the visible events. */
export interface ContextMember {
  event: JsonlEvent;
  index: number;
}

interface HostedValue {
  members: readonly ContextMember[];
  markRead: () => void;
}

const HostedContext = createContext<HostedValue | null>(null);

/**
 * Hands a `hostsContext` renderer the context run that follows its event.
 *
 * The run's events appear nowhere else in the transcript, so a host that never
 * reads them would drop them silently. In dev this throws instead: the reader
 * (`useHostedContext`) acknowledges in an effect, and child effects run before
 * this one.
 */
export function HostedContextProvider({
  members,
  children,
}: {
  members: readonly ContextMember[];
  children: ReactNode;
}) {
  const read = useRef(false);
  const value = useMemo(
    () => ({
      members,
      markRead: () => {
        read.current = true;
      },
    }),
    [members],
  );
  useEffect(() => {
    if (import.meta.env.DEV && !read.current) {
      throw new Error(
        `A hostsContext renderer never called useHostedContext(): ${members.length} context event(s) after it are not rendered anywhere.`,
      );
    }
  }, [members]);
  return <HostedContext value={value}>{children}</HostedContext>;
}

/**
 * The context run folded into this row, for a renderer contributed with
 * `hostsContext: true`; `null` when nothing follows its event. Place it with
 * `<ContextFold members={…} />`.
 */
export function useHostedContext(): readonly ContextMember[] | null {
  const value = useContext(HostedContext);
  const markRead = value?.markRead;
  useEffect(() => {
    markRead?.();
  }, [markRead]);
  return value?.members ?? null;
}
