/**
 * How long a new connection may take before the watch looks at the cluster
 * through its held session. A connect on an idle cluster takes milliseconds;
 * well under the 60 s connect deadline, so the look happens while the stall is
 * still going on.
 */
export const CONNECT_STALL_MS = 5_000;

/**
 * Open a new connection (`connect`), and if it has not answered within
 * `stallMs`, run `onStalled` while it is still pending — the moment there is
 * something to see. Settles once both have; rejects with the connect's error
 * (a missed deadline stays as loud as it was), or the look's, or both.
 */
export async function probeNewConnection(deps: {
  connect: () => Promise<void>;
  onStalled: (stalledMs: number) => Promise<void>;
  stallMs: number;
}): Promise<void> {
  const connected = deps.connect();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<"stalled">((resolve) => {
    timer = setTimeout(() => resolve("stalled"), deps.stallMs);
  });
  try {
    const first = await Promise.race([
      connected.then(() => "connected" as const),
      stalled,
    ]);
    if (first === "connected") return;
  } finally {
    clearTimeout(timer);
  }
  const [look, connect] = await Promise.allSettled([
    deps.onStalled(deps.stallMs),
    connected,
  ]);
  const errors = [connect, look].flatMap((r) =>
    r.status === "rejected" ? [r.reason as unknown] : [],
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "a new connection stalled, and the look at the cluster failed too",
    );
  }
}
