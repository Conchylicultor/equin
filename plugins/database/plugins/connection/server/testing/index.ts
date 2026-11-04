// A proxy in front of the cluster whose forwarding can be switched off, so a
// suite can make any connection's calls go unanswered.
export { startBlackHoleProxy, type BlackHoleProxy } from "./black-hole-proxy";
// The error a call with no reply rejects with, so a suite can assert which
// pool and phase lost it.
export { QueryDeadlineExceededError } from "../internal/deadline";
// The error a call on a connection whose session the server ended for idling
// in its transaction rejects with.
export { IdleTransactionEndedError } from "../internal/idle-transaction";
