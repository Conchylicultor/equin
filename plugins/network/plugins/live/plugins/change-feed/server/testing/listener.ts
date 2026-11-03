import { openListenSession } from "@plugins/database/plugins/connection/server";
import {
  createChangeFeedListener as createListener,
  type ChangeFeedListenerOptions,
} from "../internal/listener";

/** A listener's options, its LISTEN session opened on `connectionString`. */
export type TestChangeFeedListenerOptions = Omit<
  ChangeFeedListenerOptions,
  "listen"
> & {
  /** A suite's own database, on its DIRECT socket. */
  connectionString: () => string;
};

/**
 * An isolated LISTEN consumer on a suite's own database: the real listener
 * over the desktop driver's session (`openListenSession`, the one
 * `DatabaseDriver.listen` opens), pointed at the suite's connection string
 * rather than the worktree's.
 */
export function createChangeFeedListener(
  opts: TestChangeFeedListenerOptions,
): ReturnType<typeof createListener> {
  const { connectionString, ...rest } = opts;
  return createListener({
    ...rest,
    listen: (channels, handlers) =>
      openListenSession({
        name: "change-feed",
        connectionString: connectionString(),
        channels,
        handlers,
        // Loud in a suite: an unhandled rejection fails the run.
        endFailed: (err) => {
          throw err;
        },
      }),
  });
}
