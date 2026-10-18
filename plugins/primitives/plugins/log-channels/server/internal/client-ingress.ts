import { getOrCreateChannel } from "./registry";
import type { EmitLogsBody } from "../../core/endpoints";
import { LogPersistence } from "./persistence";

/**
 * Ingest ONE `POST /api/logs/emit` body. Route-internal ONLY (the emit handler) —
 * NOT exported from the plugin barrel. Persistence here is inherent to the ingress
 * (client logs must survive), which is exactly why this can't be a general
 * `Log.emit` callable from arbitrary server code: durable channels are declared,
 * and the browser's open-ended channel family is the host's
 * (`LogPersistence.clientSinkFor` — on the desktop one shared bounded rotation,
 * declared once as the `client-log` family bound).
 *
 * It takes the whole validated body rather than one line, because this function
 * exists for exactly one route: the wire type IS its domain type, so the zod
 * `.min(1).max(MAX_EMIT_LINES)` that bounds the array is the same type the ingress
 * consumes, and there is no singular form left for a handler to loop over. The
 * channel is resolved once, and the batch reaches the sink as ONE write.
 *
 * The `map` below is the layer boundary where the wire's `t` becomes the
 * registry's `timestamp` — one name per concept, renamed in exactly one place.
 */
export function emitClientLogs(body: EmitLogsBody): void {
  const { channel: channelId } = body;
  const channel = getOrCreateChannel(channelId, () =>
    LogPersistence.get().clientSinkFor(channelId),
  );
  channel.publishAll(
    body.lines.map((l) => ({ line: l.line, stream: l.stream, timestamp: l.t })),
  );
}
