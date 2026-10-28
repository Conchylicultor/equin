// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: it takes kernel flocks
// (`packages/flock`, `bun:ffi`) and spawns a wait child. Never import it from
// `web/`.
export { arrive, createTicketLine } from "./internal/ticket-line";
export type { Ticket, TicketLine, TicketPlace } from "./internal/ticket-line";
