import { join } from "node:path";
import { defineFileSink } from "@plugins/infra/plugins/file-sink/core";
import { logsDir } from "./persist";

// The browser `clientLog` ingress is the ONE genuinely open-ended sink family:
// `POST /api/logs/emit` carries an ARBITRARY, browser-supplied channel id, so
// each such channel can't be its own `defineFileSink` (no fixed path known
// ahead of time). On the desktop they ALL share the same 128 MB × 3 rotation via
// `openDynamicSink` (log-channels#machine), which sanitizes the id into the logs
// dir and does NOT touch the sink registry (registering each dynamic id would
// make the registry itself unbounded).
//
// The whole family is declared ONCE as a single `file:client-log` bound so it is
// enumerable and growth-bounded in `getFileSinks()` — the whole point of the
// durable-sink invariant. `defineFileSink` is per-path, which the family isn't;
// this representative entry (path `<logsDir>/client-log.jsonl`, never itself
// written unless a browser literally names a channel "client-log") stands in for
// the family. The real per-channel writes go to sibling `<channel>.jsonl` files
// under the same rotation. Declared at import, its path resolved lazily:
// resolving the logs dir asks for this process's runtime namespace.
export const clientLogFamily = defineFileSink({
  id: "client-log",
  description:
    "Family bound for browser clientLog ingress channels (open-ended, " +
    "browser-supplied ids). Every <channel>.jsonl written by POST /api/logs/emit " +
    "shares this 128 MB × 3 rotation via openDynamicSink; this representative " +
    "entry makes the family enumerable/bounded in getFileSinks().",
  path: () => join(logsDir(), "client-log.jsonl"),
});
