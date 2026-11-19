import { CONNECTION_TYPES, type SlowPageLoadPayload } from "../../core";

interface NetworkInformation {
  effectiveType?: string;
}

/**
 * The network class the browser reports (Chrome's Network Information API,
 * `navigator.connection.effectiveType`), or null where there is none (Safari,
 * Firefox) or it names something outside the known set.
 */
export function connectionType(): SlowPageLoadPayload["connection"] {
  const info = (navigator as Navigator & { connection?: NetworkInformation })
    .connection;
  const t = info?.effectiveType;
  return CONNECTION_TYPES.find((c) => c === t) ?? null;
}
