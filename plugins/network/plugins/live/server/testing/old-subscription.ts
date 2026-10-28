import type { z } from "zod";
import { notificationsWsHandler } from "@plugins/framework/plugins/server-core/core";

/**
 * What an OLD bundle's tab gets when it subscribes a key the way its own
 * descriptor did — the C39 check of
 * research/2026-10-06-global-scoped-change-routing-p8-v3.md (*As landed →
 * 16b.3*, the open item): a key converted to `liveCollection(key, { all })`
 * keeps its name, so a tab still running the bundle that declared it with a
 * param-less legacy descriptor subscribes `{}` against the new entry.
 *
 * - `refused` — the server answered `sub-error` (the params gate, an unknown
 *   key): `verdict` is the resource-protocol verdict the tab acts on (`skew`
 *   = out of date, reload).
 * - `parsed` — a `sub-ack` whose value the OLD schema parses; `value` is that
 *   parse's output, what the old tab renders.
 * - `parse-failed` — a `sub-ack` whose value the OLD schema rejects: the old
 *   tab fails a parse instead of hearing `skew`. A converting step must never
 *   land this — keep the wire rows compatible, or rename the key (then the old
 *   key is `unknown-key`, a `skew` verdict).
 */
export type OldSubscription =
  | { kind: "refused"; reason: string; verdict: string | undefined }
  | { kind: "parsed"; value: unknown; raw: unknown }
  | { kind: "parse-failed"; error: string; raw: unknown };

/** The old descriptor's half the harness needs: its key and its payload schema. */
export interface OldDescriptor {
  key: string;
  /** The old payload schema (`z.array(OldRowSchema)` for a legacy keyed descriptor). */
  schema: z.ZodType<unknown>;
}

interface WsHandler {
  open(ws: unknown): void;
  message(ws: unknown, raw: string): void;
  close(ws: unknown, code: number, reason: string): void;
}

interface Frame {
  kind: string;
  key?: string;
  params?: Record<string, string>;
  value?: unknown;
  reason?: string;
  verdict?: string;
}

/**
 * Subscribe `old.key` on the server runtime as an old bundle's tab would —
 * its own socket, `params` (default `{}`: a legacy param-less descriptor sent
 * nothing), its `build` graph when given — and answer what that tab gets: the
 * first `sub-ack` or `sub-error` for the tuple, the ack's value parsed with
 * the OLD schema. Throws when neither arrives within `timeoutMs`.
 *
 * Drives server-core's runtime by default (whatever the suite registered
 * there); `handler` points it at another runtime's `notificationsWsHandler`.
 */
export async function subscribeAsOldDescriptor(
  old: OldDescriptor,
  opts: {
    params?: Record<string, string>;
    build?: string;
    handler?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<OldSubscription> {
  const handler = (opts.handler ?? notificationsWsHandler) as WsHandler;
  const params = opts.params ?? {};
  const wanted = JSON.stringify(params);
  let settle: (frame: Frame) => void = () => {};
  const answered = new Promise<Frame>((resolve) => {
    settle = resolve;
  });
  const ws = {
    send(raw: string) {
      const frame = JSON.parse(raw) as Frame;
      if (
        (frame.kind === "sub-ack" || frame.kind === "sub-error") &&
        frame.key === old.key &&
        JSON.stringify(frame.params ?? {}) === wanted
      ) {
        settle(frame);
      }
    },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `subscribeAsOldDescriptor("${old.key}", ${wanted}): no sub-ack or sub-error within ${opts.timeoutMs ?? 10_000} ms`,
          ),
        ),
      opts.timeoutMs ?? 10_000,
    );
  });
  handler.open(ws);
  try {
    handler.message(
      ws,
      JSON.stringify({
        op: "sub",
        key: old.key,
        params,
        ...(opts.build !== undefined ? { build: opts.build } : {}),
      }),
    );
    const frame = await Promise.race([answered, timeout]);
    if (frame.kind === "sub-error") {
      return {
        kind: "refused",
        reason: frame.reason ?? "",
        verdict: frame.verdict,
      };
    }
    const parsed = old.schema.safeParse(frame.value);
    return parsed.success
      ? { kind: "parsed", value: parsed.data, raw: frame.value }
      : {
          kind: "parse-failed",
          error: parsed.error.message,
          raw: frame.value,
        };
  } finally {
    clearTimeout(timer);
    handler.close(ws, 1000, "old-descriptor harness");
  }
}
