import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import { Companion, type CompanionStatus } from "../slots";

/** The header's status line, joined from every `Companion.Status` part. */
export type StatusLine =
  | { kind: "pending" }
  | { kind: "ready"; text: string | null; attention: boolean };

const StatusLineContext = createContext<StatusLine | null>(null);

/** The panel's joined status line (inside {@link StatusLineProvider}). */
export function useStatusLine(): StatusLine {
  const line = useContext(StatusLineContext);
  if (line === null) {
    throw new Error("useStatusLine() needs a <CompanionPanel> around it.");
  }
  return line;
}

/**
 * Join the parts in slot order. Not-known-yet is a state: while any part is
 * pending (or has not reported yet) the whole line is pending, so it never
 * shows a partial claim it would then extend.
 */
function joinStatuses(
  order: readonly string[],
  byId: ReadonlyMap<string, CompanionStatus>,
): StatusLine {
  const texts: string[] = [];
  let attention = false;
  for (const id of order) {
    const s = byId.get(id);
    if (s === undefined || s.kind === "pending") return { kind: "pending" };
    if (s.kind === "failed") {
      texts.push(`Couldn't read ${s.subject}`);
      continue;
    }
    if (s.text !== null) texts.push(s.text);
    attention ||= s.attention;
  }
  return {
    kind: "ready",
    text: texts.length > 0 ? texts.join(" · ") : null,
    attention,
  };
}

function sameStatus(
  a: CompanionStatus | undefined,
  b: CompanionStatus,
): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** Runs one part's `useStatus` (a hook, so as a component) and reports it up. */
function StatusReader({
  id,
  useStatus,
  report,
}: {
  id: string;
  useStatus: Hook<() => CompanionStatus>;
  report: (id: string, status: CompanionStatus | null) => void;
}): null {
  const status = useStatus();
  // Reported in a layout effect, so the line is joined before paint.
  useLayoutEffect(() => report(id, status), [id, status, report]);
  useLayoutEffect(() => () => report(id, null), [id, report]);
  return null;
}

/**
 * Collects the `Companion.Status` parts into the header's line and hands their
 * attention to the host (`onAttention`: the menu-bar icon's dot, a badge),
 * when it has somewhere to show it. Mounted once by `CompanionPanel`, around
 * its sections.
 */
export function StatusLineProvider({
  onAttention,
  children,
}: {
  onAttention: ((on: boolean) => void) | null;
  children: ReactNode;
}) {
  const order = Companion.Status.useContributions().map((c) => c.id);
  const [byId, setById] = useState<ReadonlyMap<string, CompanionStatus>>(
    () => new Map(),
  );
  const report = useCallback(
    (id: string, status: CompanionStatus | null) =>
      setById((prev) => {
        if (status === null) {
          if (!prev.has(id)) return prev;
          const next = new Map(prev);
          next.delete(id);
          return next;
        }
        if (sameStatus(prev.get(id), status)) return prev;
        return new Map(prev).set(id, status);
      }),
    [],
  );
  const line = joinStatuses(order, byId);

  // Pending says nothing yet: the host keeps what it showed until the line is
  // known again.
  const attention = line.kind === "ready" ? line.attention : null;
  useEffect(() => {
    if (onAttention === null || attention === null) return;
    onAttention(attention);
  }, [onAttention, attention]);

  return (
    <>
      {/* The readers paint nothing; they only report. */}
      <div hidden>
        <Companion.Status.Render>
          {(item) => (
            <StatusReader
              id={item.id}
              useStatus={item.useStatus}
              report={report}
            />
          )}
        </Companion.Status.Render>
      </div>
      <StatusLineContext value={line}>{children}</StatusLineContext>
    </>
  );
}
