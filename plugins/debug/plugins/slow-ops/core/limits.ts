// Max client slow-op items accepted per `POST /api/slow-ops/client` request.
// Shared so the browser queue chunks its flush to this size and can never form
// a batch the server will reject — the same contract `MAX_EMIT_LINES` has for
// the log-channels emit beacon (see log-channels/core/endpoints.ts). The chunk
// size, not the accumulated queue length, bounds each request.
export const MAX_CLIENT_SLOW_OP_ITEMS = 200;

// Cap on slow-op marker lines read per worktree file (newest kept). Generous so a
// chatty backend's window is never truncated before the health pane's read
// window cuts it off; the web layer coalesces markers to the 10s sample grid
// regardless. Also the cap the health pane's value declares on each backend's
// markers.
export const MAX_SLOW_OP_MARKERS = 5000;
