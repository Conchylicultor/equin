import { EndpointError, endpointErrorSink } from "@plugins/infra/plugins/endpoints/web";
import type { Transport } from "@plugins/primitives/plugins/networking/web";

// Async generator yielding one parsed JSON frame per line, over the caller's
// transport (`useTransport()`), so a stream inside a scoped subtree never
// reaches the page's server. Guards res.ok so a plain-text gateway error (e.g.
// "backend unavailable") is surfaced + reported instead of crashing
// JSON.parse; restores crash reporting for streamed routes.
export async function* readNdjson(
  transport: Transport,
  route: string,
  url: string,
  init?: RequestInit,
): AsyncGenerator<Record<string, unknown>> {
  const res = await transport.fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => null);
    if (transport.telemetry) {
      endpointErrorSink.emit({ route, status: res.status, body });
    }
    throw new EndpointError(res.status, body ?? `HTTP ${res.status}`);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line) as Record<string, unknown>;
    }
  }
}
