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
import { MenuBar, type MenuBarStatus } from "../slots";
import { useNativeHost } from "../native-host";

/** The header's status line, joined from every `MenuBar.Status` part. */
export type StatusLine =
  | { kind: "pending" }
  | { kind: "ready"; text: string | null; attention: boolean };

const StatusLineContext = createContext<StatusLine | null>(null);

/** The panel's joined status line (inside {@link PanelStatus}). */
export function useStatusLine(): StatusLine {
  const line = useContext(StatusLineContext);
  if (line === null) {
    throw new Error("useStatusLine() needs the panel's <PanelStatus>.");
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
  byId: ReadonlyMap<string, MenuBarStatus>,
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

function sameStatus(a: MenuBarStatus | undefined, b: MenuBarStatus): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** Runs one part's `useStatus` (a hook, so as a component) and reports it up. */
function StatusReader({
  id,
  useStatus,
  report,
}: {
  id: string;
  useStatus: Hook<() => MenuBarStatus>;
  report: (id: string, status: MenuBarStatus | null) => void;
}): null {
  const status = useStatus();
  // Reported in a layout effect, so the line is joined before paint.
  useLayoutEffect(() => report(id, status), [id, status, report]);
  useLayoutEffect(() => () => report(id, null), [id, report]);
  return null;
}

/**
 * Collects the `MenuBar.Status` parts into the header's line and mirrors their
 * attention onto the menu-bar icon's dot (when the host has one). Mounted once
 * by the panel, around its sections.
 */
export function PanelStatus({ children }: { children: ReactNode }) {
  const order = MenuBar.Status.useContributions().map((c) => c.id);
  const [byId, setById] = useState<ReadonlyMap<string, MenuBarStatus>>(
    () => new Map(),
  );
  const report = useCallback(
    (id: string, status: MenuBarStatus | null) =>
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

  const host = useNativeHost();
  const setAttention = host.kind === "present" ? host.setAttention : null;
  // Pending says nothing yet: the dot keeps what it showed until the line is
  // known again.
  const attention = line.kind === "ready" ? line.attention : null;
  useEffect(() => {
    if (setAttention === null || attention === null) return;
    void setAttention(attention);
  }, [setAttention, attention]);

  return (
    <>
      {/* The readers paint nothing; they only report. */}
      <div hidden>
        <MenuBar.Status.Render>
          {(item) => (
            <StatusReader
              id={item.id}
              useStatus={item.useStatus}
              report={report}
            />
          )}
        </MenuBar.Status.Render>
      </div>
      <StatusLineContext value={line}>{children}</StatusLineContext>
    </>
  );
}
